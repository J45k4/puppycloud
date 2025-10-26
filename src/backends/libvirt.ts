import { FFIType, dlopen, suffix } from "bun:ffi"
import type { FFIFunction, Library, Pointer } from "bun:ffi"
import { BackendError } from "./errors"
import { registerPointer, unregisterPointer } from "./ffi-utils"
import type { VirtualMachineBackend, VirtualMachineCreateOptions, VirtualMachineInfo, VirtualMachineListOptions, VirtualMachineMountInfo, VirtualMachineMountOptions, VirtualMachineReference, VirtualMachineState } from "./vm"

const TEXT_ENCODER = new TextEncoder()
const TEXT_DECODER = new TextDecoder()
const VIR_DOMAIN_NAME_MAX = 255
const VIR_UUID_STRING_LENGTH = 36
const VIR_DOMAIN_AFFECT_LIVE = 1
const VIR_DOMAIN_AFFECT_CONFIG = 2
const VIR_DOMAIN_DEVICE_APPLY_BOTH = VIR_DOMAIN_AFFECT_LIVE | VIR_DOMAIN_AFFECT_CONFIG
const VIR_DOMAIN_XML_INACTIVE = 2

const LIBVIRT_SYMBOLS = {
	virConnectOpen: { args: [FFIType.cstring], returns: FFIType.ptr },
	virConnectClose: { args: [FFIType.ptr], returns: FFIType.int },
	virConnectNumOfDomains: { args: [FFIType.ptr], returns: FFIType.int },
	virConnectListDomains: { args: [FFIType.ptr, FFIType.ptr, FFIType.int], returns: FFIType.int },
	virConnectNumOfDefinedDomains: { args: [FFIType.ptr], returns: FFIType.int },
	virConnectListDefinedDomains: { args: [FFIType.ptr, FFIType.ptr, FFIType.int], returns: FFIType.int },
	virDomainLookupByID: { args: [FFIType.ptr, FFIType.int], returns: FFIType.ptr },
	virDomainLookupByName: { args: [FFIType.ptr, FFIType.cstring], returns: FFIType.ptr },
	virDomainLookupByUUIDString: { args: [FFIType.ptr, FFIType.cstring], returns: FFIType.ptr },
	virDomainGetUUIDString: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.int },
	virDomainGetName: { args: [FFIType.ptr], returns: FFIType.cstring },
	virDomainGetID: { args: [FFIType.ptr], returns: FFIType.int },
	virDomainGetState: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.uint32_t], returns: FFIType.int },
	virDomainIsActive: { args: [FFIType.ptr], returns: FFIType.int },
	virDomainIsPersistent: { args: [FFIType.ptr], returns: FFIType.int },
	virDomainGetAutostart: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.int },
	virDomainSetAutostart: { args: [FFIType.ptr, FFIType.int], returns: FFIType.int },
	virDomainCreateXML: { args: [FFIType.ptr, FFIType.cstring, FFIType.uint32_t], returns: FFIType.ptr },
	virDomainDefineXML: { args: [FFIType.ptr, FFIType.cstring], returns: FFIType.ptr },
	virDomainCreate: { args: [FFIType.ptr], returns: FFIType.int },
	virDomainShutdown: { args: [FFIType.ptr], returns: FFIType.int },
	virDomainDestroy: { args: [FFIType.ptr], returns: FFIType.int },
	virDomainUndefine: { args: [FFIType.ptr], returns: FFIType.int },
	virDomainFree: { args: [FFIType.ptr], returns: FFIType.int },
	virDomainGetXMLDesc: { args: [FFIType.ptr, FFIType.uint32_t], returns: FFIType.cstring },
	virDomainAttachDeviceFlags: { args: [FFIType.ptr, FFIType.ptr, FFIType.uint32_t], returns: FFIType.int },
	virDomainDetachDeviceFlags: { args: [FFIType.ptr, FFIType.ptr, FFIType.uint32_t], returns: FFIType.int },
	virFree: { args: [FFIType.ptr], returns: FFIType.int }
} as const satisfies Record<string, FFIFunction>

type LibvirtLibrary = Library<typeof LIBVIRT_SYMBOLS>
type LibvirtSymbols = LibvirtLibrary["symbols"]

export interface LibvirtBackendOptions {
	uri?: string
	libraryPath?: string
	library?: LibvirtLibrary
}

export class LibvirtBackend implements VirtualMachineBackend {
	private readonly libvirt: LibvirtLibrary
	private readonly symbols: LibvirtSymbols
	private readonly uri?: string
	private connection: Pointer | null

	constructor(options: LibvirtBackendOptions = {}) {
		this.uri = options.uri
		this.libvirt = options.library ?? loadLibvirtLibrary(options.libraryPath)
		this.symbols = this.libvirt.symbols
		this.connection = this.openConnection()
	}

	async close(): Promise<void> {
		if (this.connection) {
			this.symbols.virConnectClose(this.connection)
			this.connection = null
		}
		this.libvirt.close()
	}

	async listVirtualMachines(options: VirtualMachineListOptions = {}): Promise<VirtualMachineInfo[]> {
		const includeActive = options.includeActive !== false
		const includeInactive = options.includeInactive !== false
		const conn = this.requireConnection()
		const results: VirtualMachineInfo[] = []
		const seen = new Set<string>()

		if (includeActive) {
			const activeIds = this.listActiveDomainIds(conn)
			for (const domainId of activeIds) {
				const domainPtr = this.symbols.virDomainLookupByID(conn, domainId)
				if (domainPtr === null) {
					continue
				}
				try {
					const info = this.buildDomainInfo(domainPtr)
					results.push(info)
					seen.add(info.uuid)
				} finally {
					this.symbols.virDomainFree(domainPtr)
				}
			}
		}

		if (includeInactive) {
			const definedNames = this.listDefinedDomainNames(conn)
			for (const { pointer } of definedNames) {
				const domainPtr = this.symbols.virDomainLookupByName(conn, pointer)
				if (domainPtr === null) {
					unregisterPointer(pointer)
					continue
				}
				try {
					const info = this.buildDomainInfo(domainPtr)
					if (!seen.has(info.uuid)) {
						results.push(info)
					}
				} finally {
					this.symbols.virDomainFree(domainPtr)
					unregisterPointer(pointer)
				}
			}
		}

		return results
	}

	async getVirtualMachine(reference: VirtualMachineReference): Promise<VirtualMachineInfo> {
		const domainPtr = this.lookupDomain(reference)
		try {
			return this.buildDomainInfo(domainPtr)
		} finally {
			this.symbols.virDomainFree(domainPtr)
		}
	}

	async createVirtualMachine(options: VirtualMachineCreateOptions): Promise<VirtualMachineInfo> {
		const xml = options.xml?.trim()
		if (!xml) {
			throw new BackendError("A virtual machine XML definition is required")
		}
		const conn = this.requireConnection()
		const xmlBuffer = this.createCString(xml)
		const xmlPointer = registerPointer(xmlBuffer)
		const persistent = options.persistent === true
		const start = options.start !== false

		try {
			if (persistent) {
				const domainPtr = this.symbols.virDomainDefineXML(conn, xmlPointer)
				if (!domainPtr) {
					throw new BackendError("Libvirt did not return a domain for the defined virtual machine")
				}
				try {
					if (typeof options.autostart === "boolean") {
						this.ensureSuccess(this.symbols.virDomainSetAutostart(domainPtr, options.autostart ? 1 : 0), "virDomainSetAutostart")
					}
					if (start) {
						this.ensureSuccess(this.symbols.virDomainCreate(domainPtr), "virDomainCreate")
					}
					return this.buildDomainInfo(domainPtr)
				} finally {
					this.symbols.virDomainFree(domainPtr)
				}
			}

			if (!start) {
				throw new BackendError("Transient virtual machines must start immediately; set persistent=true to control start behavior")
			}

			const domainPtr = this.symbols.virDomainCreateXML(conn, xmlPointer, 0)
			if (!domainPtr) {
				throw new BackendError("Libvirt did not return a domain for the created virtual machine")
			}
			try {
				return this.buildDomainInfo(domainPtr)
			} finally {
				this.symbols.virDomainFree(domainPtr)
			}
		} finally {
			unregisterPointer(xmlPointer)
		}
	}

	async startVirtualMachine(reference: VirtualMachineReference): Promise<void> {
		const domainPtr = this.lookupDomain(reference)
		try {
			this.ensureSuccess(this.symbols.virDomainCreate(domainPtr), "virDomainCreate")
		} finally {
			this.symbols.virDomainFree(domainPtr)
		}
	}

	async shutdownVirtualMachine(reference: VirtualMachineReference): Promise<void> {
		const domainPtr = this.lookupDomain(reference)
		try {
			this.ensureSuccess(this.symbols.virDomainShutdown(domainPtr), "virDomainShutdown")
		} finally {
			this.symbols.virDomainFree(domainPtr)
		}
	}

	async destroyVirtualMachine(reference: VirtualMachineReference): Promise<void> {
		const domainPtr = this.lookupDomain(reference)
		try {
			this.ensureSuccess(this.symbols.virDomainDestroy(domainPtr), "virDomainDestroy")
		} finally {
			this.symbols.virDomainFree(domainPtr)
		}
	}

	async undefineVirtualMachine(reference: VirtualMachineReference): Promise<void> {
		const domainPtr = this.lookupDomain(reference)
		try {
			this.ensureSuccess(this.symbols.virDomainUndefine(domainPtr), "virDomainUndefine")
		} finally {
			this.symbols.virDomainFree(domainPtr)
		}
	}

	async setAutostart(reference: VirtualMachineReference, autostart: boolean): Promise<void> {
		const domainPtr = this.lookupDomain(reference)
		try {
			this.ensureSuccess(this.symbols.virDomainSetAutostart(domainPtr, autostart ? 1 : 0), "virDomainSetAutostart")
		} finally {
			this.symbols.virDomainFree(domainPtr)
		}
	}

	async listVirtualMachineMounts(reference: VirtualMachineReference): Promise<VirtualMachineMountInfo[]> {
		const domainPtr = this.lookupDomain(reference)
		try {
			const xml = this.getDomainXml(domainPtr)
			return this.parseVirtualMachineMounts(xml)
		} finally {
			this.symbols.virDomainFree(domainPtr)
		}
	}

	async attachVirtualMachineMount(reference: VirtualMachineReference, mount: VirtualMachineMountOptions): Promise<void> {
		if (mount.type !== "nfs") {
			throw new BackendError(`Unsupported virtual machine mount type ${mount.type}`)
		}
		const domainPtr = this.lookupDomain(reference)
		try {
			const xml = this.buildNfsFilesystemXml(mount)
			const xmlBuffer = this.createCString(xml)
			const xmlPointer = registerPointer(xmlBuffer)
			try {
				this.ensureSuccess(this.symbols.virDomainAttachDeviceFlags(domainPtr, xmlPointer, VIR_DOMAIN_DEVICE_APPLY_BOTH), "virDomainAttachDeviceFlags")
			} finally {
				unregisterPointer(xmlPointer)
			}
		} finally {
			this.symbols.virDomainFree(domainPtr)
		}
	}

	async detachVirtualMachineMount(reference: VirtualMachineReference, targetPath: string): Promise<void> {
		const normalizedTarget = targetPath?.trim()
		if (!normalizedTarget) {
			throw new BackendError("A target path is required to detach a virtual machine mount")
		}
		const domainPtr = this.lookupDomain(reference)
		try {
			const xml = this.getDomainXml(domainPtr)
			const mounts = this.parseVirtualMachineMounts(xml)
			const mount = mounts.find((entry) => entry.target.path === normalizedTarget)
			if (!mount) {
				throw new BackendError(`Virtual machine mount with target ${normalizedTarget} was not found`)
			}
			const mountXml = this.buildNfsFilesystemXml(mount)
			const xmlBuffer = this.createCString(mountXml)
			const xmlPointer = registerPointer(xmlBuffer)
			try {
				this.ensureSuccess(this.symbols.virDomainDetachDeviceFlags(domainPtr, xmlPointer, VIR_DOMAIN_DEVICE_APPLY_BOTH), "virDomainDetachDeviceFlags")
			} finally {
				unregisterPointer(xmlPointer)
			}
		} finally {
			this.symbols.virDomainFree(domainPtr)
		}
	}

	private lookupDomain(reference: VirtualMachineReference): Pointer {
		const conn = this.requireConnection()
		if ("uuid" in reference) {
			const uuidBuffer = this.createCString(reference.uuid)
			const uuidPointer = registerPointer(uuidBuffer)
			try {
				const domainPtr = this.symbols.virDomainLookupByUUIDString(conn, uuidPointer)
				if (domainPtr === null) {
					throw new BackendError(`Virtual machine with uuid ${reference.uuid} was not found`)
				}
				return domainPtr
			} finally {
				unregisterPointer(uuidPointer)
			}
		}
		if ("name" in reference) {
			const nameBuffer = this.createCString(reference.name)
			const namePointer = registerPointer(nameBuffer)
			try {
				const domainPtr = this.symbols.virDomainLookupByName(conn, namePointer)
				if (domainPtr === null) {
					throw new BackendError(`Virtual machine with name ${reference.name} was not found`)
				}
				return domainPtr
			} finally {
				unregisterPointer(namePointer)
			}
		}
		const domainPtr = this.symbols.virDomainLookupByID(conn, reference.id)
		if (domainPtr === null) {
			throw new BackendError(`Virtual machine with id ${reference.id} was not found`)
		}
		return domainPtr
	}

	private listActiveDomainIds(conn: Pointer): number[] {
		const count = this.symbols.virConnectNumOfDomains(conn)
		if (count < 0) {
			throw new BackendError("Failed to list active virtual machines")
		}
		if (count === 0) {
			return []
		}
		const ids = new Int32Array(count)
		const idsPointer = registerPointer(ids)
		try {
			const result = this.symbols.virConnectListDomains(conn, idsPointer, count)
			if (result < 0) {
				throw new BackendError("Failed to retrieve active virtual machine identifiers")
			}
			return Array.from(ids.slice(0, result))
		} finally {
			unregisterPointer(idsPointer)
		}
	}

	private listDefinedDomainNames(conn: Pointer): Array<{ name: string; pointer: Pointer }> {
		const count = this.symbols.virConnectNumOfDefinedDomains(conn)
		if (count < 0) {
			throw new BackendError("Failed to list defined virtual machines")
		}
		if (count === 0) {
			return []
		}
		const namesPointerArray = new BigUint64Array(count)
		const nameBuffers: Array<{ buffer: Uint8Array; pointer: Pointer }> = []
		for (let index = 0; index < count; index += 1) {
			const buffer = new Uint8Array(VIR_DOMAIN_NAME_MAX + 1)
			const pointer = registerPointer(buffer)
			namesPointerArray[index] = BigInt(pointer)
			nameBuffers.push({ buffer, pointer })
		}
		const pointerArrayPointer = registerPointer(namesPointerArray)
		try {
			const result = this.symbols.virConnectListDefinedDomains(conn, pointerArrayPointer, count)
			if (result < 0) {
				throw new BackendError("Failed to retrieve defined virtual machine names")
			}
			const items: Array<{ name: string; pointer: Pointer }> = []
			for (let index = 0; index < result; index += 1) {
				const entry = nameBuffers[index]
				if (!entry) {
					continue
				}
				const name = this.readCString(entry.buffer)
				if (name) {
					items.push({ name, pointer: entry.pointer })
				} else {
					unregisterPointer(entry.pointer)
				}
			}
			for (let index = result; index < nameBuffers.length; index += 1) {
				const entry = nameBuffers[index]
				if (entry) {
					unregisterPointer(entry.pointer)
				}
			}
			return items
		} finally {
			unregisterPointer(pointerArrayPointer)
		}
	}

	private buildDomainInfo(domainPtr: Pointer): VirtualMachineInfo {
		const uuidBuffer = new Uint8Array(VIR_UUID_STRING_LENGTH + 1)
		const uuidPointer = registerPointer(uuidBuffer)
		try {
			this.ensureSuccess(this.symbols.virDomainGetUUIDString(domainPtr, uuidPointer), "virDomainGetUUIDString")
		} finally {
			unregisterPointer(uuidPointer)
		}
		const uuid = this.readCString(uuidBuffer)
		const nameValue = this.symbols.virDomainGetName(domainPtr)
		const name = nameValue ? nameValue.toString() : ""
		const id = this.symbols.virDomainGetID(domainPtr)
		const stateArray = new Int32Array(1)
		const reasonArray = new Int32Array(1)
		const statePointer = registerPointer(stateArray)
		const reasonPointer = registerPointer(reasonArray)
		try {
			this.ensureSuccess(this.symbols.virDomainGetState(domainPtr, statePointer, reasonPointer, 0), "virDomainGetState")
		} finally {
			unregisterPointer(statePointer)
			unregisterPointer(reasonPointer)
		}
		const isActive = this.symbols.virDomainIsActive(domainPtr) === 1
		const isPersistent = this.symbols.virDomainIsPersistent(domainPtr) === 1
		const autostartArray = new Int32Array(1)
		const autostartPointer = registerPointer(autostartArray)
		let autostart: boolean | undefined
		try {
			const result = this.symbols.virDomainGetAutostart(domainPtr, autostartPointer)
			if (result === 0) {
				autostart = autostartArray[0] === 1
			}
		} finally {
			unregisterPointer(autostartPointer)
		}
		return {
			id: id >= 0 ? id : null,
			name,
			uuid,
			state: this.mapDomainState(stateArray[0]),
			stateReason: reasonArray[0] ?? undefined,
			isActive,
			isPersistent,
			autostart
		}
	}

	private getDomainXml(domainPtr: Pointer): string {
		const xmlValue = this.symbols.virDomainGetXMLDesc(domainPtr, VIR_DOMAIN_XML_INACTIVE)
		if (!xmlValue) {
			throw new BackendError("Libvirt did not return domain XML")
		}
		try {
			return xmlValue.toString()
		} finally {
			this.symbols.virFree(xmlValue.ptr)
		}
	}

	private parseVirtualMachineMounts(xml: string): VirtualMachineMountInfo[] {
		const mounts: VirtualMachineMountInfo[] = []
		const filesystemRegex = /<filesystem\b([^>]*)>([\s\S]*?)<\/filesystem>/gi
		let match = filesystemRegex.exec(xml)
		while (match) {
			const current = match
			match = filesystemRegex.exec(xml)
			const attributes = this.parseXmlAttributes(current[1] ?? "")
			if (attributes.get("type") !== "network") {
				continue
			}
			const body = current[2] ?? ""
			const sourceMatch = /<source\b([^>]*)>([\s\S]*?)<\/source>/i.exec(body) ?? /<source\b([^>]*)\/>/i.exec(body)
			if (!sourceMatch) {
				continue
			}
			const sourceAttributes = this.parseXmlAttributes(sourceMatch[1] ?? "")
			if (sourceAttributes.get("protocol") !== "nfs") {
				continue
			}
			const hostMatch = /<host\b([^>]*)\/>/i.exec(sourceMatch[2] ?? "")
			const hostAttributes = hostMatch ? this.parseXmlAttributes(hostMatch[1] ?? "") : new Map<string, string>()
			const host = (hostAttributes.get("name") ?? "").trim()
			const sourcePath = (sourceAttributes.get("name") ?? "").trim()
			const targetMatch = /<target\b([^>]*)\/>/i.exec(body)
			if (!host || !sourcePath || !targetMatch) {
				continue
			}
			const targetAttributes = this.parseXmlAttributes(targetMatch[1] ?? "")
			const targetPath = (targetAttributes.get("dir") ?? "").trim()
			if (!targetPath) {
				continue
			}
			const portText = (hostAttributes.get("port") ?? "").trim()
			let port: number | undefined
			if (portText) {
				const parsed = Number.parseInt(portText, 10)
				if (!Number.isNaN(parsed)) {
					port = parsed
				}
			}
			const readonly = /<readonly\b[^>]*\/>/i.test(body)
			const source = port !== undefined ? { host, path: sourcePath, port } : { host, path: sourcePath }
			mounts.push({
				type: "nfs",
				source,
				target: { path: targetPath },
				readonly
			})
		}
		return mounts
	}

	private parseXmlAttributes(content: string): Map<string, string> {
		const attributes = new Map<string, string>()
		const regex = /([:\w-]+)\s*=\s*("([^"]*)"|'([^']*)')/g
		let match = regex.exec(content)
		while (match) {
			const current = match
			match = regex.exec(content)
			const key = current[1]
			if (!key) {
				continue
			}
			const value = (current[3] ?? current[4] ?? "").trim()
			attributes.set(key, value)
		}
		return attributes
	}

	private buildNfsFilesystemXml(mount: VirtualMachineMountOptions | VirtualMachineMountInfo): string {
		const host = mount.source.host?.trim()
		const path = mount.source.path?.trim()
		const targetPath = mount.target.path?.trim()
		if (!host) {
			throw new BackendError("An NFS mount requires a source host")
		}
		if (!path) {
			throw new BackendError("An NFS mount requires a source path")
		}
		if (!targetPath) {
			throw new BackendError("An NFS mount requires a target path")
		}
		let portSegment = ""
		if (typeof mount.source.port === "number") {
			if (!Number.isInteger(mount.source.port) || mount.source.port <= 0) {
				throw new BackendError("An NFS mount port must be a positive integer")
			}
			portSegment = ` port='${this.escapeXml(String(mount.source.port))}'`
		}
		const readonlySegment = mount.readonly ? "\n        <readonly/>" : ""
		return `<filesystem type='network' accessmode='passthrough'>\n        <source protocol='nfs' name='${this.escapeXml(path)}'>\n                <host name='${this.escapeXml(host)}'${portSegment}/>\n        </source>\n        <target dir='${this.escapeXml(targetPath)}'/>${readonlySegment}\n</filesystem>`
	}

	private escapeXml(value: string): string {
		return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;")
	}

	private mapDomainState(value: number | undefined): VirtualMachineState {
		switch (value) {
			case 0:
				return "noState"
			case 1:
				return "running"
			case 2:
				return "blocked"
			case 3:
				return "paused"
			case 4:
				return "shutdown"
			case 5:
				return "shutoff"
			case 6:
				return "crashed"
			case 7:
				return "suspended"
			default:
				return "unknown"
		}
	}

	private ensureSuccess(result: number, operation: string): void {
		if (result < 0) {
			throw new BackendError(`Libvirt operation ${operation} failed`)
		}
	}

	private createCString(value: string): Uint8Array {
		const encoded = TEXT_ENCODER.encode(value)
		const buffer = new Uint8Array(encoded.length + 1)
		buffer.set(encoded)
		buffer[encoded.length] = 0
		return buffer
	}

	private readCString(buffer: Uint8Array): string {
		const zeroIndex = buffer.indexOf(0)
		const end = zeroIndex === -1 ? buffer.length : zeroIndex
		if (end === 0) {
			return ""
		}
		return TEXT_DECODER.decode(buffer.subarray(0, end))
	}

	private openConnection(): Pointer {
		if (this.uri) {
			const uriBuffer = this.createCString(this.uri)
			const uriPointer = registerPointer(uriBuffer)
			try {
				const conn = this.symbols.virConnectOpen(uriPointer)
				if (!conn) {
					throw new BackendError(`Failed to open libvirt connection for uri ${this.uri}`)
				}
				return conn
			} finally {
				unregisterPointer(uriPointer)
			}
		}
		const conn = this.symbols.virConnectOpen(null)
		if (!conn) {
			throw new BackendError("Failed to open libvirt connection")
		}
		return conn
	}

	private requireConnection(): Pointer {
		if (!this.connection) {
			throw new BackendError("The libvirt connection has been closed")
		}
		return this.connection
	}
}

function loadLibvirtLibrary(libraryPath?: string): LibvirtLibrary {
	if (libraryPath) {
		return dlopen(libraryPath, LIBVIRT_SYMBOLS)
	}
	const candidates = [`libvirt.${suffix}`, "libvirt.so.0", "libvirt-2.0.so.0", `libvirt-2.0.${suffix}`]
	const errors: Error[] = []
	for (const candidate of candidates) {
		try {
			return dlopen(candidate, LIBVIRT_SYMBOLS)
		} catch (error) {
			if (error instanceof Error) {
				errors.push(error)
			}
		}
	}
	const detail = errors.map((error) => error.message).join(", ")
	throw new BackendError(`Failed to load libvirt library${detail ? `: ${detail}` : ""}`)
}

export function createLibvirtBackend(options?: LibvirtBackendOptions): LibvirtBackend {
	return new LibvirtBackend(options)
}

export type { LibvirtLibrary }
