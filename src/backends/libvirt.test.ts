import { describe, expect, it } from "bun:test"
import { CString } from "bun:ffi"
import type { Pointer } from "bun:ffi"
import { registerPointer, getRegisteredView, unregisterPointer } from "./ffi-utils"
import { BackendError } from "./errors"
import { LibvirtBackend, type LibvirtBackendOptions, type LibvirtLibrary } from "./libvirt"

interface FakeDomain {
	id: number
	name: string
	uuid: string
	isActive: boolean
	isPersistent: boolean
	autostart: boolean
	state: number
	stateReason: number
	pointer: Pointer
	namePointer: Pointer
	xml: string
	filesystems: FakeFilesystem[]
}

interface FakeFilesystem {
	type: "nfs"
	source: { host: string; path: string; port?: number }
	target: { path: string }
	readonly: boolean
}

interface FakeLibvirtState {
	domains: FakeDomain[]
	nextId: number
	nextPointer: number
	closed: boolean
	allocatedStrings: Set<Pointer>
}

const VIR_DOMAIN_RUNNING = 1
const VIR_DOMAIN_SHUTOFF = 5
const VIR_DOMAIN_SHUTDOWN = 4

function encodeCString(value: string): Uint8Array {
	const encoder = new TextEncoder()
	const bytes = encoder.encode(value)
	const buffer = new Uint8Array(bytes.length + 1)
	buffer.set(bytes)
	buffer[bytes.length] = 0
	return buffer
}

function decodeCString(pointer: Pointer): string {
	const view = getRegisteredView(pointer)
	if (!(view instanceof Uint8Array)) {
		throw new Error("Expected Uint8Array for string buffer")
	}
	const zeroIndex = view.indexOf(0)
	const slice = zeroIndex === -1 ? view : view.subarray(0, zeroIndex)
	return new TextDecoder().decode(slice)
}

function parseAttributes(content: string): Map<string, string> {
	const attributes = new Map<string, string>()
	const regex = /([:\w-]+)\s*=\s*("([^"]*)"|'([^']*)')/g
	let match: RegExpExecArray | null = regex.exec(content)
	while (match) {
		const key = match[1]
		if (!key) {
			match = regex.exec(content)
			continue
		}
		const value = (match[3] ?? match[4] ?? "").trim()
		attributes.set(key, value)
		match = regex.exec(content)
	}
	return attributes
}

function escapeXml(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;")
}

function parseFilesystemXml(xml: string): FakeFilesystem | undefined {
	const typeMatch = xml.match(/<filesystem\b([^>]*)>/i)
	if (!typeMatch) {
		return undefined
	}
	const typeAttributes = parseAttributes(typeMatch[1] ?? "")
	if (typeAttributes.get("type")?.toLowerCase() !== "network") {
		return undefined
	}
	const sourceMatch = xml.match(/<source\b([^>]*)>/i)
	if (!sourceMatch) {
		return undefined
	}
	const sourceAttributes = parseAttributes(sourceMatch[1] ?? "")
	if (sourceAttributes.get("protocol")?.toLowerCase() !== "nfs") {
		return undefined
	}
	const sourcePath = (sourceAttributes.get("name") ?? "").trim()
	const hostMatch = xml.match(/<host\b([^>]*)\/>/i)
	if (!hostMatch) {
		return undefined
	}
	const hostAttributes = parseAttributes(hostMatch[1] ?? "")
	const host = (hostAttributes.get("name") ?? "").trim()
	if (!host) {
		return undefined
	}
	const portText = (hostAttributes.get("port") ?? "").trim()
	const targetMatch = xml.match(/<target\b([^>]*)\/>/i)
	if (!targetMatch) {
		return undefined
	}
	const targetAttributes = parseAttributes(targetMatch[1] ?? "")
	const targetPath = (targetAttributes.get("dir") ?? "").trim()
	if (!sourcePath || !targetPath) {
		return undefined
	}
	let port: number | undefined
	if (portText) {
		const parsed = Number.parseInt(portText, 10)
		if (!Number.isNaN(parsed)) {
			port = parsed
		}
	}
	const readonly = /<readonly\b[^>]*\/>/i.test(xml)
	const source = port !== undefined ? { host, path: sourcePath, port } : { host, path: sourcePath }
	return {
		type: "nfs",
		source,
		target: { path: targetPath },
		readonly
	}
}

function extractFilesystemsFromXml(xml: string): FakeFilesystem[] {
	const filesystems: FakeFilesystem[] = []
	const regex = /<filesystem\b[\s\S]*?<\/filesystem>/gi
	let match: RegExpExecArray | null = regex.exec(xml)
	while (match) {
		const filesystem = parseFilesystemXml(match[0] ?? "")
		if (filesystem) {
			filesystems.push(filesystem)
		}
		match = regex.exec(xml)
	}
	return filesystems
}

function cloneFilesystem(filesystem: FakeFilesystem): FakeFilesystem {
	const clone: FakeFilesystem = {
		type: "nfs",
		source: { host: filesystem.source.host, path: filesystem.source.path },
		target: { path: filesystem.target.path },
		readonly: filesystem.readonly
	}
	if (typeof filesystem.source.port === "number") {
		clone.source.port = filesystem.source.port
	}
	return clone
}

function buildFilesystemXml(filesystem: FakeFilesystem): string {
	const portSegment = typeof filesystem.source.port === "number" ? ` port='${escapeXml(String(filesystem.source.port))}'` : ""
	const readonlySegment = filesystem.readonly ? "\n                <readonly/>" : ""
	return `<filesystem type='network' accessmode='passthrough'>\n                <source protocol='nfs' name='${escapeXml(filesystem.source.path)}'>\n                        <host name='${escapeXml(filesystem.source.host)}'${portSegment}/>\n                </source>\n                <target dir='${escapeXml(filesystem.target.path)}'/>${readonlySegment}\n        </filesystem>`
}

function buildDomainXml(domain: FakeDomain): string {
	const filesystemsXml = domain.filesystems.map((filesystem) => buildFilesystemXml(filesystem)).join("\n")
	return `<domain type='kvm'>\n        <name>${escapeXml(domain.name)}</name>\n        <uuid>${escapeXml(domain.uuid)}</uuid>\n        <devices>${filesystemsXml ? `\n${filesystemsXml}\n        ` : ""}</devices>\n</domain>`
}
function createFakeDomain(state: FakeLibvirtState, data: Partial<FakeDomain> & { name: string; uuid: string; xml?: string }): FakeDomain {
	const nameBuffer = encodeCString(data.name)
	const namePointer = registerPointer(nameBuffer)
	state.nextPointer += 0x10
	const pointerValue = state.nextPointer as Pointer
	const filesystems = data.filesystems ? data.filesystems.map((filesystem) => cloneFilesystem(filesystem)) : data.xml ? extractFilesystemsFromXml(data.xml) : []
	const domain: FakeDomain = {
		id: data.id ?? state.nextId++,
		name: data.name,
		uuid: data.uuid,
		isActive: data.isActive ?? false,
		isPersistent: data.isPersistent ?? true,
		autostart: data.autostart ?? false,
		state: data.state ?? (data.isActive ? VIR_DOMAIN_RUNNING : VIR_DOMAIN_SHUTOFF),
		stateReason: data.stateReason ?? 0,
		pointer: pointerValue,
		namePointer,
		xml: data.xml ?? "",
		filesystems
	}
	state.domains.push(domain)
	return domain
}

function writeCString(targetPointer: Pointer, value: string): void {
	const view = getRegisteredView(targetPointer)
	if (!(view instanceof Uint8Array)) {
		throw new Error("Expected Uint8Array for string buffer")
	}
	const encoded = encodeCString(value)
	view.fill(0)
	view.set(encoded.subarray(0, Math.min(view.length, encoded.length)))
}

function getDomainInfo(state: FakeLibvirtState, pointer: Pointer): FakeDomain | undefined {
	return state.domains.find((domain) => domain.pointer === pointer)
}

function lookupDomainById(state: FakeLibvirtState, id: number): FakeDomain | undefined {
	return state.domains.find((domain) => domain.id === id && domain.isActive)
}

function lookupDomainByName(state: FakeLibvirtState, name: string): FakeDomain | undefined {
	return state.domains.find((domain) => domain.name === name)
}

function lookupDomainByUuid(state: FakeLibvirtState, uuid: string): FakeDomain | undefined {
	return state.domains.find((domain) => domain.uuid === uuid)
}

function extractNameFromXml(xml: string): string | undefined {
	const match = xml.match(/<name>([^<]+)<\/name>/i)
	return match?.[1]
}

function createFakeLibvirtLibrary(state: FakeLibvirtState): LibvirtLibrary {
	return {
		symbols: {
			virConnectOpen: (_uriPointer: Pointer | null): Pointer | null => {
				state.closed = false
				return 0x1000 as Pointer
			},
			virConnectClose: (): number => {
				state.closed = true
				return 0
			},
			virConnectNumOfDomains: (): number => {
				return state.domains.filter((domain) => domain.isActive).length
			},
			virConnectListDomains: (_conn: Pointer, idsPointer: Pointer, max: number): number => {
				const view = getRegisteredView(idsPointer)
				if (!(view instanceof Int32Array)) {
					throw new Error("Expected Int32Array for domain id buffer")
				}
				const active = state.domains.filter((domain) => domain.isActive)
				const count = Math.min(max, active.length)
				for (let index = 0; index < count; index += 1) {
					view[index] = active[index]?.id ?? -1
				}
				return count
			},
			virConnectNumOfDefinedDomains: (): number => {
				return state.domains.filter((domain) => !domain.isActive && domain.isPersistent).length
			},
			virConnectListDefinedDomains: (_conn: Pointer, namesPointer: Pointer, max: number): number => {
				const pointerView = getRegisteredView(namesPointer)
				if (!(pointerView instanceof BigUint64Array)) {
					throw new Error("Expected BigUint64Array for defined domain pointers")
				}
				const defined = state.domains.filter((domain) => !domain.isActive && domain.isPersistent)
				const count = Math.min(max, defined.length)
				for (let index = 0; index < count; index += 1) {
					const pointerValue = Number(pointerView[index]) as Pointer
					writeCString(pointerValue, defined[index]?.name ?? "")
				}
				return count
			},
			virDomainLookupByID: (_conn: Pointer, id: number): Pointer | null => {
				const domain = lookupDomainById(state, id)
				return domain?.pointer ?? null
			},
			virDomainLookupByName: (_conn: Pointer, namePointer: Pointer): Pointer | null => {
				const view = getRegisteredView(namePointer)
				if (!(view instanceof Uint8Array)) {
					throw new Error("Expected Uint8Array for name lookup")
				}
				const zeroIndex = view.indexOf(0)
				const name = new TextDecoder().decode(zeroIndex === -1 ? view : view.subarray(0, zeroIndex))
				return lookupDomainByName(state, name)?.pointer ?? null
			},
			virDomainLookupByUUIDString: (_conn: Pointer, uuidPointer: Pointer): Pointer | null => {
				const view = getRegisteredView(uuidPointer)
				if (!(view instanceof Uint8Array)) {
					throw new Error("Expected Uint8Array for uuid lookup")
				}
				const zeroIndex = view.indexOf(0)
				const uuid = new TextDecoder().decode(zeroIndex === -1 ? view : view.subarray(0, zeroIndex))
				return lookupDomainByUuid(state, uuid)?.pointer ?? null
			},
			virDomainGetUUIDString: (domainPointer: Pointer, targetPointer: Pointer): number => {
				const domain = getDomainInfo(state, domainPointer)
				if (!domain) {
					return -1
				}
				writeCString(targetPointer, domain.uuid)
				return 0
			},
			virDomainGetName: (domainPointer: Pointer): CString | null => {
				const domain = getDomainInfo(state, domainPointer)
				if (!domain) {
					return null
				}
				return new CString(domain.namePointer)
			},
			virDomainGetID: (domainPointer: Pointer): number => {
				const domain = getDomainInfo(state, domainPointer)
				return domain?.isActive ? domain.id : -1
			},
			virDomainGetState: (domainPointer: Pointer, statePointer: Pointer, reasonPointer: Pointer, _flags: number): number => {
				const domain = getDomainInfo(state, domainPointer)
				if (!domain) {
					return -1
				}
				const stateView = getRegisteredView(statePointer)
				const reasonView = getRegisteredView(reasonPointer)
				if (!(stateView instanceof Int32Array) || !(reasonView instanceof Int32Array)) {
					throw new Error("Expected Int32Array for state buffers")
				}
				stateView[0] = domain.state
				reasonView[0] = domain.stateReason
				return 0
			},
			virDomainIsActive: (domainPointer: Pointer): number => {
				const domain = getDomainInfo(state, domainPointer)
				return domain?.isActive ? 1 : 0
			},
			virDomainIsPersistent: (domainPointer: Pointer): number => {
				const domain = getDomainInfo(state, domainPointer)
				return domain?.isPersistent ? 1 : 0
			},
			virDomainGetAutostart: (domainPointer: Pointer, target: Pointer): number => {
				const domain = getDomainInfo(state, domainPointer)
				if (!domain) {
					return -1
				}
				const view = getRegisteredView(target)
				if (!(view instanceof Int32Array)) {
					throw new Error("Expected Int32Array for autostart buffer")
				}
				view[0] = domain.autostart ? 1 : 0
				return 0
			},
			virDomainSetAutostart: (domainPointer: Pointer, enabled: number): number => {
				const domain = getDomainInfo(state, domainPointer)
				if (!domain) {
					return -1
				}
				domain.autostart = enabled === 1
				return 0
			},
			virDomainGetXMLDesc: (domainPointer: Pointer, _flags: number): CString | null => {
				const domain = getDomainInfo(state, domainPointer)
				if (!domain) {
					return null
				}
				const xml = buildDomainXml(domain)
				domain.xml = xml
				const buffer = encodeCString(xml)
				const pointer = registerPointer(buffer)
				state.allocatedStrings.add(pointer)
				return new CString(pointer)
			},
			virDomainAttachDeviceFlags: (domainPointer: Pointer, xmlPointer: Pointer, _flags: number): number => {
				const domain = getDomainInfo(state, domainPointer)
				if (!domain) {
					return -1
				}
				const xml = decodeCString(xmlPointer)
				const filesystem = parseFilesystemXml(xml)
				if (!filesystem) {
					return -1
				}
				domain.filesystems.push(filesystem)
				domain.xml = buildDomainXml(domain)
				return 0
			},
			virDomainDetachDeviceFlags: (domainPointer: Pointer, xmlPointer: Pointer, _flags: number): number => {
				const domain = getDomainInfo(state, domainPointer)
				if (!domain) {
					return -1
				}
				const xml = decodeCString(xmlPointer)
				const filesystem = parseFilesystemXml(xml)
				if (!filesystem) {
					return -1
				}
				const index = domain.filesystems.findIndex((existing) => {
					if (existing.target.path !== filesystem.target.path) {
						return false
					}
					if (existing.source.host !== filesystem.source.host) {
						return false
					}
					if (existing.source.path !== filesystem.source.path) {
						return false
					}
					return existing.source.port === filesystem.source.port
				})
				if (index === -1) {
					return -1
				}
				domain.filesystems.splice(index, 1)
				domain.xml = buildDomainXml(domain)
				return 0
			},
			virDomainCreateXML: (_conn: Pointer, xmlPointer: Pointer, _flags: number): Pointer | null => {
				const view = getRegisteredView(xmlPointer)
				if (!(view instanceof Uint8Array)) {
					throw new Error("Expected Uint8Array for xml buffer")
				}
				const zeroIndex = view.indexOf(0)
				const xml = new TextDecoder().decode(zeroIndex === -1 ? view : view.subarray(0, zeroIndex))
				const name = extractNameFromXml(xml) ?? `transient-${state.nextId}`
				const domain = createFakeDomain(state, {
					name,
					uuid: crypto.randomUUID(),
					isActive: true,
					isPersistent: false,
					autostart: false,
					state: VIR_DOMAIN_RUNNING,
					xml
				})
				return domain.pointer
			},
			virDomainDefineXML: (_conn: Pointer, xmlPointer: Pointer): Pointer | null => {
				const view = getRegisteredView(xmlPointer)
				if (!(view instanceof Uint8Array)) {
					throw new Error("Expected Uint8Array for xml buffer")
				}
				const zeroIndex = view.indexOf(0)
				const xml = new TextDecoder().decode(zeroIndex === -1 ? view : view.subarray(0, zeroIndex))
				const name = extractNameFromXml(xml) ?? `defined-${state.nextId}`
				const domain = createFakeDomain(state, {
					name,
					uuid: crypto.randomUUID(),
					isActive: false,
					isPersistent: true,
					autostart: false,
					state: VIR_DOMAIN_SHUTOFF,
					xml
				})
				return domain.pointer
			},
			virDomainCreate: (domainPointer: Pointer): number => {
				const domain = getDomainInfo(state, domainPointer)
				if (!domain) {
					return -1
				}
				domain.isActive = true
				domain.state = VIR_DOMAIN_RUNNING
				return 0
			},
			virDomainShutdown: (domainPointer: Pointer): number => {
				const domain = getDomainInfo(state, domainPointer)
				if (!domain) {
					return -1
				}
				domain.isActive = false
				domain.state = VIR_DOMAIN_SHUTDOWN
				return 0
			},
			virDomainDestroy: (domainPointer: Pointer): number => {
				const domain = getDomainInfo(state, domainPointer)
				if (!domain) {
					return -1
				}
				domain.isActive = false
				domain.state = VIR_DOMAIN_SHUTOFF
				return 0
			},
			virDomainUndefine: (domainPointer: Pointer): number => {
				const domain = getDomainInfo(state, domainPointer)
				if (!domain) {
					return -1
				}
				domain.isPersistent = false
				return 0
			},
			virDomainFree: (_domainPointer: Pointer): number => 0,
			virFree: (pointer: Pointer): number => {
				if (state.allocatedStrings.has(pointer)) {
					state.allocatedStrings.delete(pointer)
					unregisterPointer(pointer)
					return 0
				}
				return -1
			}
		},
		close(): void {
			state.closed = true
		}
	} as unknown as LibvirtLibrary
}

function createBackend(initialDomains?: Array<Partial<FakeDomain> & { name: string; uuid: string }>): LibvirtBackend {
	const state: FakeLibvirtState = {
		domains: [],
		nextId: 101,
		nextPointer: 0x2000,
		closed: false,
		allocatedStrings: new Set()
	}
	const defaults: Array<Partial<FakeDomain> & { name: string; uuid: string }> = [
		{
			name: "builder",
			uuid: "11111111-1111-1111-1111-111111111111",
			isActive: true,
			isPersistent: true,
			autostart: true,
			state: VIR_DOMAIN_RUNNING
		},
		{
			name: "staging",
			uuid: "22222222-2222-2222-2222-222222222222",
			isActive: false,
			isPersistent: true,
			autostart: false,
			state: VIR_DOMAIN_SHUTOFF
		}
	]
	for (const domain of initialDomains ?? defaults) {
		createFakeDomain(state, domain)
	}
	const library = createFakeLibvirtLibrary(state)
	return new LibvirtBackend({ library } satisfies LibvirtBackendOptions)
}

describe("LibvirtBackend", () => {
	it("lists active and defined virtual machines", async () => {
		const backend = createBackend()
		try {
			const vms = await backend.listVirtualMachines()
			expect(vms).toHaveLength(2)
			const names = vms.map((vm) => vm.name).sort()
			expect(names).toEqual(["builder", "staging"])
			const builder = vms.find((vm) => vm.name === "builder")
			expect(builder?.isActive).toBe(true)
			expect(builder?.autostart).toBe(true)
			const staging = vms.find((vm) => vm.name === "staging")
			expect(staging?.isActive).toBe(false)
		} finally {
			await backend.close()
		}
	})

	it("creates persistent virtual machines without starting them", async () => {
		const backend = createBackend([])
		try {
			const vm = await backend.createVirtualMachine({
				xml: "<domain><name>db</name></domain>",
				persistent: true,
				start: false,
				autostart: false
			})
			expect(vm.name).toBe("db")
			expect(vm.isPersistent).toBe(true)
			expect(vm.isActive).toBe(false)
			const all = await backend.listVirtualMachines()
			expect(all.some((item) => item.name === "db")).toBe(true)
		} finally {
			await backend.close()
		}
	})

	it("starts virtual machines", async () => {
		const backend = createBackend()
		try {
			await backend.startVirtualMachine({ name: "staging" })
			const vm = await backend.getVirtualMachine({ name: "staging" })
			expect(vm.isActive).toBe(true)
			expect(vm.state).toBe("running")
		} finally {
			await backend.close()
		}
	})

	it("shuts down virtual machines", async () => {
		const backend = createBackend()
		try {
			await backend.startVirtualMachine({ name: "staging" })
			await backend.shutdownVirtualMachine({ name: "staging" })
			const vm = await backend.getVirtualMachine({ name: "staging" })
			expect(vm.isActive).toBe(false)
			expect(vm.state).toBe("shutdown")
		} finally {
			await backend.close()
		}
	})

	it("destroys virtual machines", async () => {
		const backend = createBackend()
		try {
			await backend.startVirtualMachine({ name: "staging" })
			await backend.destroyVirtualMachine({ name: "staging" })
			const vm = await backend.getVirtualMachine({ name: "staging" })
			expect(vm.isActive).toBe(false)
			expect(vm.state).toBe("shutoff")
		} finally {
			await backend.close()
		}
	})

	it("undefines virtual machines", async () => {
		const backend = createBackend()
		try {
			await backend.undefineVirtualMachine({ name: "staging" })
			const vms = await backend.listVirtualMachines({ includeActive: false, includeInactive: true })
			expect(vms.some((vm) => vm.name === "staging")).toBe(false)
		} finally {
			await backend.close()
		}
	})

	it("sets autostart", async () => {
		const backend = createBackend()
		try {
			await backend.setAutostart({ name: "staging" }, true)
			const vm = await backend.getVirtualMachine({ name: "staging" })
			expect(vm.autostart).toBe(true)
		} finally {
			await backend.close()
		}
	})

	it("throws when virtual machine cannot be found", async () => {
		const backend = createBackend([])
		try {
			await expect(backend.getVirtualMachine({ name: "missing" })).rejects.toBeInstanceOf(BackendError)
		} finally {
			await backend.close()
		}
	})

	it("lists NFS mounts from domain xml", async () => {
		const backend = createBackend([
			{
				name: "files",
				uuid: "33333333-3333-3333-3333-333333333333",
				isActive: false,
				isPersistent: true,
				autostart: false,
				state: VIR_DOMAIN_SHUTOFF,
				filesystems: [
					{
						type: "nfs",
						source: { host: "storage.internal", path: "/exports/projects", port: 2049 },
						target: { path: "/mnt/projects" },
						readonly: false
					},
					{
						type: "nfs",
						source: { host: "storage.internal", path: "/exports/assets" },
						target: { path: "/mnt/assets" },
						readonly: true
					}
				]
			}
		])
		try {
			const mounts = await backend.listVirtualMachineMounts({ name: "files" })
			expect(mounts).toHaveLength(2)
			expect(mounts).toEqual([
				{
					type: "nfs",
					source: { host: "storage.internal", path: "/exports/projects", port: 2049 },
					target: { path: "/mnt/projects" },
					readonly: false
				},
				{
					type: "nfs",
					source: { host: "storage.internal", path: "/exports/assets" },
					target: { path: "/mnt/assets" },
					readonly: true
				}
			])
		} finally {
			await backend.close()
		}
	})

	it("attaches NFS mounts", async () => {
		const backend = createBackend([
			{
				name: "builder",
				uuid: "11111111-1111-1111-1111-111111111111",
				isActive: true,
				isPersistent: true,
				autostart: false,
				state: VIR_DOMAIN_RUNNING,
				filesystems: []
			}
		])
		try {
			await backend.attachVirtualMachineMount(
				{ name: "builder" },
				{
					type: "nfs",
					source: { host: "nas.local", path: "/exports/code", port: 2049 },
					target: { path: "/mnt/code" }
				}
			)
			const mounts = await backend.listVirtualMachineMounts({ name: "builder" })
			expect(mounts).toEqual([
				{
					type: "nfs",
					source: { host: "nas.local", path: "/exports/code", port: 2049 },
					target: { path: "/mnt/code" },
					readonly: false
				}
			])
		} finally {
			await backend.close()
		}
	})

	it("detaches NFS mounts by target path", async () => {
		const backend = createBackend([
			{
				name: "builder",
				uuid: "11111111-1111-1111-1111-111111111111",
				isActive: true,
				isPersistent: true,
				autostart: false,
				state: VIR_DOMAIN_RUNNING,
				filesystems: [
					{
						type: "nfs",
						source: { host: "nas.local", path: "/exports/code", port: 2049 },
						target: { path: "/mnt/code" },
						readonly: false
					}
				]
			}
		])
		try {
			await backend.detachVirtualMachineMount({ name: "builder" }, "/mnt/code")
			const mounts = await backend.listVirtualMachineMounts({ name: "builder" })
			expect(mounts).toHaveLength(0)
		} finally {
			await backend.close()
		}
	})

	it("rejects unsupported mount types", async () => {
		const backend = createBackend()
		try {
			await expect(
				backend.attachVirtualMachineMount({ name: "builder" }, {
					type: "smb",
					source: { host: "files", path: "/share" },
					target: { path: "/mnt/share" }
				} as unknown as Parameters<LibvirtBackend["attachVirtualMachineMount"]>[1])
			).rejects.toBeInstanceOf(BackendError)
		} finally {
			await backend.close()
		}
	})

	it("rejects detaching missing mounts", async () => {
		const backend = createBackend()
		try {
			await expect(backend.detachVirtualMachineMount({ name: "builder" }, "/missing")).rejects.toBeInstanceOf(BackendError)
		} finally {
			await backend.close()
		}
	})
})
