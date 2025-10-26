import http from "node:http"
import { Buffer } from "node:buffer"
import { posix as posixPath } from "node:path"
import { URLSearchParams } from "node:url"
import type { Backend, BackendCreateOptions, BackendExecOptions, BackendExecResult, BackendFileEntry, BackendInstanceInfo, BackendListOptions, BackendLogOptions, BackendPathInfo, BackendPathType, BackendRemoveOptions, BackendStopOptions } from "./base"
import { BackendRequestError } from "./errors"

export interface DockerBackendOptions {
	socketPath?: string
	requestTimeoutMs?: number
}

interface DockerListContainer {
	Id: string
	Names?: string[]
	Image?: string
	State?: string
	Status?: string
	Created?: number
}

interface DockerCreateResponse {
	Id: string
	Warnings?: string[] | null
}

interface DockerExecCreateResponse {
	Id: string
}

interface DockerErrorResponse {
	message?: string
}

interface DockerRequestOptions {
	method: string
	path: string
	body?: unknown
	headers?: http.OutgoingHttpHeaders
}

interface DockerResponse {
	statusCode: number
	headers: http.IncomingHttpHeaders
	bodyText: string
	bodyBuffer: Buffer
}

interface DockerPathStat {
	name?: string
	size?: number
	mode?: number
	mtime?: number | string
	linkTarget?: string
}

type TarEntryType = "file" | "directory" | "symlink" | "other"

interface TarEntry {
	name: string
	type: TarEntryType
	size: number
	mtime?: number
	data?: Buffer
	linkName?: string
}

export class DockerBackend implements Backend {
	private readonly socketPath: string
	private readonly requestTimeoutMs: number

	constructor(options: DockerBackendOptions = {}) {
		this.socketPath = options.socketPath ?? "/var/run/docker.sock"
		this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000
	}

	async listInstances(options: BackendListOptions = {}): Promise<BackendInstanceInfo[]> {
		const params = new URLSearchParams()
		params.set("all", options.all ? "1" : "0")
		const response = await this.request({
			method: "GET",
			path: `/containers/json?${params.toString()}`
		})
		const payload = this.parseJson<DockerListContainer[]>(response)
		return payload.map((container) => ({
			id: container.Id,
			name: container.Names?.[0]?.replace(/^\//, ""),
			image: container.Image,
			state: container.State,
			status: container.Status,
			createdAt: container.Created
		}))
	}

	async createInstance(options: BackendCreateOptions): Promise<BackendInstanceInfo> {
		const params = new URLSearchParams()
		if (options.name) {
			params.set("name", options.name)
		}
		const response = await this.request({
			method: "POST",
			path: `/containers/create${params.size > 0 ? `?${params.toString()}` : ""}`,
			body: this.toDockerCreateBody(options)
		})
		const payload = this.parseJson<DockerCreateResponse>(response)
		return {
			id: payload.Id,
			name: options.name,
			image: options.image
		}
	}

	async startInstance(id: string): Promise<void> {
		await this.request({
			method: "POST",
			path: `/containers/${encodeURIComponent(id)}/start`
		})
	}

	async stopInstance(id: string, options: BackendStopOptions = {}): Promise<void> {
		const params = new URLSearchParams()
		if (typeof options.timeoutSeconds === "number") {
			params.set("t", String(options.timeoutSeconds))
		}
		const query = params.size > 0 ? `?${params.toString()}` : ""
		await this.request({
			method: "POST",
			path: `/containers/${encodeURIComponent(id)}/stop${query}`
		})
	}

	async removeInstance(id: string, options: BackendRemoveOptions = {}): Promise<void> {
		const params = new URLSearchParams()
		if (options.force) {
			params.set("force", "1")
		}
		if (options.removeVolumes) {
			params.set("v", "1")
		}
		const query = params.size > 0 ? `?${params.toString()}` : ""
		await this.request({
			method: "DELETE",
			path: `/containers/${encodeURIComponent(id)}${query}`
		})
	}

	async inspectInstance(id: string): Promise<Record<string, unknown>> {
		const response = await this.request({
			method: "GET",
			path: `/containers/${encodeURIComponent(id)}/json`
		})
		return this.parseJson<Record<string, unknown>>(response)
	}

	async getInstanceLogs(id: string, options: BackendLogOptions = {}): Promise<string> {
		const params = new URLSearchParams()
		params.set("stdout", options.stdout === false ? "0" : "1")
		params.set("stderr", options.stderr === false ? "0" : "1")
		params.set("timestamps", "0")
		params.set("follow", "0")
		if (typeof options.since === "number") {
			params.set("since", String(options.since))
		}
		if (typeof options.tail === "number") {
			params.set("tail", String(options.tail))
		} else if (options.tail === "all") {
			params.set("tail", "all")
		}
		const response = await this.request({
			method: "GET",
			path: `/containers/${encodeURIComponent(id)}/logs?${params.toString()}`,
			headers: {
				Accept: "text/plain"
			}
		})
		return response.bodyText
	}

	async execInstanceCommand(id: string, command: string[], options: BackendExecOptions = {}): Promise<BackendExecResult> {
		if (!Array.isArray(command) || command.length === 0) {
			throw new BackendRequestError("A command is required to exec into the container", 400)
		}

		const createResponse = await this.request({
			method: "POST",
			path: `/containers/${encodeURIComponent(id)}/exec`,
			body: {
				AttachStdout: true,
				AttachStderr: true,
				Tty: true,
				Cmd: command,
				WorkingDir: options.workingDirectory
			}
		})

		const execInfo = this.parseJson<DockerExecCreateResponse>(createResponse)
		if (!execInfo?.Id) {
			throw new BackendRequestError("Docker did not return an exec identifier", 500, execInfo)
		}

		const startResponse = await this.request({
			method: "POST",
			path: `/exec/${encodeURIComponent(execInfo.Id)}/start`,
			body: {
				Detach: false,
				Tty: true
			},
			headers: {
				Accept: "application/vnd.docker.raw-stream"
			}
		})
		return { output: startResponse.bodyText }
	}

	async getInstancePath(id: string, path: string): Promise<BackendPathInfo> {
		const normalizedPath = this.normalizeContainerPath(path)
		const queryPath = encodeURIComponent(normalizedPath)
		const archivePath = `/containers/${encodeURIComponent(id)}/archive?path=${queryPath}`

		const statResponse = await this.request({
			method: "HEAD",
			path: archivePath,
			headers: {
				Accept: "application/x-tar"
			}
		})

		const stat = this.decodePathStat(statResponse.headers["x-docker-container-path-stat"])
		if (!stat) {
			throw new BackendRequestError("Docker did not return path metadata", 500)
		}

		const type = this.inferPathType(stat.mode)
		const info: BackendPathInfo = {
			path: normalizedPath,
			type,
			size: typeof stat.size === "number" ? stat.size : undefined,
			modifiedAt: this.normalizeTimestamp(stat.mtime),
			linkTarget: stat.linkTarget || undefined
		}

		let archiveEntries: TarEntry[] | undefined
		const loadArchiveEntries = async (): Promise<TarEntry[]> => {
			if (!archiveEntries) {
				const archiveResponse = await this.request({
					method: "GET",
					path: archivePath,
					headers: {
						Accept: "application/x-tar"
					}
				})
				archiveEntries = this.parseTarArchive(archiveResponse.bodyBuffer)
			}
			return archiveEntries
		}

		const applyFileEntry = (entry: TarEntry): void => {
			if (!entry.data) {
				throw new BackendRequestError("Docker archive did not contain file contents", 500)
			}
			info.encoding = "base64"
			info.content = Buffer.from(entry.data).toString("base64")
			info.size = entry.size
			info.modifiedAt = entry.mtime ? new Date(entry.mtime * 1000).toISOString() : info.modifiedAt
			info.linkTarget = entry.linkName ?? info.linkTarget
		}

		if (type === "directory") {
			const entries = await loadArchiveEntries()
			info.entries = this.toDirectoryEntries(entries, normalizedPath)
			return info
		}

		if (type === "file") {
			const entries = await loadArchiveEntries()
			const fileEntry = this.findFileEntry(entries, normalizedPath)
			if (!fileEntry || this.mapEntryType(fileEntry.type) !== "file") {
				throw new BackendRequestError("Docker archive did not contain file contents", 500)
			}
			applyFileEntry(fileEntry)
			return info
		}

		const entries = await loadArchiveEntries()
		const directoryEntries = this.toDirectoryEntries(entries, normalizedPath)
		const matchingEntry = this.findArchiveEntry(entries, normalizedPath)
		const mappedMatchingType = matchingEntry ? this.mapEntryType(matchingEntry.type) : undefined

		if (mappedMatchingType === "directory" || directoryEntries.length > 0) {
			info.type = "directory"
			info.entries = directoryEntries
			if (matchingEntry) {
				info.size = typeof matchingEntry.size === "number" ? matchingEntry.size : info.size
				info.modifiedAt = matchingEntry.mtime ? new Date(matchingEntry.mtime * 1000).toISOString() : info.modifiedAt
				info.linkTarget = matchingEntry.linkName ?? info.linkTarget
			}
			return info
		}

		if (mappedMatchingType === "file" && matchingEntry) {
			info.type = "file"
			applyFileEntry(matchingEntry)
			return info
		}

		if (mappedMatchingType === "symlink" && matchingEntry) {
			info.type = "symlink"
			info.size = typeof matchingEntry.size === "number" ? matchingEntry.size : info.size
			info.modifiedAt = matchingEntry.mtime ? new Date(matchingEntry.mtime * 1000).toISOString() : info.modifiedAt
			info.linkTarget = matchingEntry.linkName ?? info.linkTarget
			if (matchingEntry.data && matchingEntry.data.length > 0) {
				info.encoding = "base64"
				info.content = Buffer.from(matchingEntry.data).toString("base64")
			}
			return info
		}

		return info
	}

	async pullImage(image: string): Promise<void> {
		const params = new URLSearchParams()
		params.set("fromImage", image)
		await this.request({
			method: "POST",
			path: `/images/create?${params.toString()}`
		})
	}

	private normalizeContainerPath(input: string): string {
		if (typeof input !== "string" || input.length === 0) {
			return "/"
		}

		const trimmed = input.trim()
		if (!trimmed || trimmed === ".") {
			return "/"
		}

		const normalized = posixPath.normalize(trimmed)
		if (normalized === ".") {
			return "/"
		}

		return normalized.startsWith("/") ? normalized : `/${normalized}`
	}

	private decodePathStat(headerValue: string | string[] | undefined): DockerPathStat | undefined {
		if (!headerValue) {
			return undefined
		}

		const raw = Array.isArray(headerValue) ? headerValue[0] : headerValue
		if (!raw) {
			return undefined
		}

		try {
			const decoded = Buffer.from(raw, "base64").toString("utf8")
			const parsed = JSON.parse(decoded) as Partial<DockerPathStat & { mode: number | string; size: number | string }>
			const modeValue = parsed.mode as number | string | undefined
			const sizeValue = parsed.size as number | string | undefined
			let mode: number | undefined
			if (typeof modeValue === "number") {
				mode = modeValue
			} else if (typeof modeValue === "string") {
				const trimmedMode = modeValue.trim()
				if (trimmedMode.length > 0) {
					const parsedMode = Number.parseInt(trimmedMode, 10)
					mode = Number.isFinite(parsedMode) ? parsedMode : undefined
				}
			}

			let size: number | undefined
			if (typeof sizeValue === "number") {
				size = sizeValue
			} else if (typeof sizeValue === "string") {
				const trimmedSize = sizeValue.trim()
				if (trimmedSize.length > 0) {
					const parsedSize = Number.parseInt(trimmedSize, 10)
					size = Number.isFinite(parsedSize) ? parsedSize : undefined
				}
			}
			return {
				name: parsed.name ?? undefined,
				mode: Number.isFinite(mode) ? mode : undefined,
				size: Number.isFinite(size) ? size : undefined,
				mtime: parsed.mtime,
				linkTarget: parsed.linkTarget ?? undefined
			}
		} catch (error) {
			throw new BackendRequestError("Failed to decode Docker path metadata", 500, error instanceof Error ? error.message : error)
		}
	}

	private inferPathType(mode: number | undefined): BackendPathType {
		if (typeof mode !== "number" || Number.isNaN(mode)) {
			return "other"
		}

		const S_IFMT = 0o170000
		const S_IFDIR = 0o040000
		const S_IFREG = 0o100000
		const S_IFLNK = 0o120000
		const typeFlag = mode & S_IFMT

		if (typeFlag === S_IFDIR) {
			return "directory"
		}
		if (typeFlag === S_IFREG) {
			return "file"
		}
		if (typeFlag === S_IFLNK) {
			return "symlink"
		}
		return "other"
	}

	private normalizeTimestamp(value: unknown): string | undefined {
		if (typeof value === "number" && Number.isFinite(value)) {
			return new Date(value * 1000).toISOString()
		}
		if (typeof value === "string") {
			const numeric = Number(value)
			if (Number.isFinite(numeric)) {
				return new Date(numeric * 1000).toISOString()
			}
			const parsed = new Date(value)
			if (!Number.isNaN(parsed.getTime())) {
				return parsed.toISOString()
			}
			return value
		}
		return undefined
	}

	private parseTarArchive(buffer: Buffer): TarEntry[] {
		const entries: TarEntry[] = []
		const blockSize = 512
		let offset = 0
		let pendingLongName: string | undefined
		let pendingLongLinkName: string | undefined
		let pendingPax: Record<string, string> | undefined

		while (offset + blockSize <= buffer.length) {
			const header = buffer.subarray(offset, offset + blockSize)
			if (header.every((byte) => byte === 0)) {
				break
			}

			const sizeOctal = this.readTarField(header, 124, 12)
			const size = sizeOctal ? Number.parseInt(sizeOctal.trim() || "0", 8) : 0
			const typeFlagByte = header[156]
			const typeChar = typeFlagByte ? String.fromCharCode(typeFlagByte) : "\0"
			const dataStart = offset + blockSize
			const dataEnd = dataStart + Math.ceil(size / blockSize) * blockSize
			const dataSlice = buffer.subarray(dataStart, dataStart + size)

			if (typeChar === "L") {
				pendingLongName = dataSlice.toString("utf8").replace(/\0+$/, "")
				offset = dataEnd
				continue
			}

			if (typeChar === "K") {
				pendingLongLinkName = dataSlice.toString("utf8").replace(/\0+$/, "")
				offset = dataEnd
				continue
			}

			if (typeChar === "x" || typeChar === "g") {
				pendingPax = this.parsePaxHeaders(dataSlice)
				offset = dataEnd
				continue
			}

			const prefix = this.readTarField(header, 345, 155)
			const rawName = pendingPax?.path ?? pendingLongName ?? this.buildTarName(prefix, this.readTarField(header, 0, 100))
			const rawLinkName = pendingPax?.linkpath ?? pendingLongLinkName ?? this.readTarField(header, 157, 100)
			const normalizedName = this.normalizeTarPath(rawName)
			const mtimeOctal = this.readTarField(header, 136, 12)
			const mtime = mtimeOctal ? Number.parseInt(mtimeOctal.trim() || "0", 8) : undefined
			const entryType = this.mapTarType(typeChar)

			if (normalizedName) {
				entries.push({
					name: normalizedName,
					type: entryType,
					size,
					mtime,
					data: dataSlice,
					linkName: rawLinkName || undefined
				})
			}

			pendingLongName = undefined
			pendingLongLinkName = undefined
			pendingPax = undefined
			offset = dataEnd
		}

		return entries
	}

	private toDirectoryEntries(entries: TarEntry[], normalizedPath: string): BackendFileEntry[] {
		const baseKey = this.getArchiveKey(normalizedPath)
		const map = new Map<string, BackendFileEntry>()

		for (const entry of entries) {
			const entryKey = entry.name
			if (!entryKey) {
				continue
			}

			let relative: string | undefined
			if (!baseKey) {
				relative = entryKey
			} else {
				if (entryKey === baseKey) {
					continue
				}
				if (entryKey.startsWith(`${baseKey}/`)) {
					relative = entryKey.slice(baseKey.length + 1)
				} else {
					relative = entryKey
				}
			}

			if (!relative) {
				continue
			}

			if (relative.startsWith("../")) {
				continue
			}

			const segments = relative.split("/").filter((segment) => segment.length > 0)
			if (segments.length === 0) {
				continue
			}

			const [firstSegment, ...restSegments] = segments
			if (!firstSegment || firstSegment === ".") {
				continue
			}
			const name = firstSegment
			const existing = map.get(name)
			const isNested = restSegments.length > 0
			const entryType: BackendPathType = isNested ? "directory" : this.mapEntryType(entry.type)
			const modifiedAt = entry.mtime ? new Date(entry.mtime * 1000).toISOString() : undefined

			if (!existing) {
				map.set(name, {
					name,
					type: entryType,
					size: !isNested ? entry.size : undefined,
					modifiedAt: !isNested ? modifiedAt : undefined,
					linkTarget: !isNested ? entry.linkName : undefined
				})
			} else {
				if (entryType === "directory" && existing.type !== "directory") {
					existing.type = "directory"
					existing.size = undefined
					existing.linkTarget = undefined
				}
				if (!existing.modifiedAt && modifiedAt) {
					existing.modifiedAt = modifiedAt
				}
			}
		}

		const sorted = Array.from(map.values()).sort((a, b) => {
			if (a.type !== b.type) {
				if (a.type === "directory") {
					return -1
				}
				if (b.type === "directory") {
					return 1
				}
			}
			return a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
		})

		return sorted
	}

	private findFileEntry(entries: TarEntry[], normalizedPath: string): TarEntry | undefined {
		const key = this.getArchiveKey(normalizedPath)
		const baseName = key.includes("/") ? (key.split("/").pop() ?? key) : key

		for (const entry of entries) {
			if (entry.type !== "file" && entry.type !== "symlink") {
				continue
			}
			if (entry.name === key || entry.name === baseName) {
				return entry
			}
		}

		return undefined
	}

	private findArchiveEntry(entries: TarEntry[], normalizedPath: string): TarEntry | undefined {
		const key = this.getArchiveKey(normalizedPath)

		if (!key) {
			for (const entry of entries) {
				if (!entry.name) {
					continue
				}
				if (entry.name === "" || entry.name === ".") {
					return entry
				}
			}
			return undefined
		}

		for (const entry of entries) {
			if (!entry.name) {
				continue
			}
			if (entry.name === key) {
				return entry
			}
		}

		return undefined
	}

	private getArchiveKey(normalizedPath: string): string {
		return normalizedPath === "/" ? "" : normalizedPath.replace(/^\/+/, "")
	}

	private mapEntryType(type: TarEntryType): BackendPathType {
		switch (type) {
			case "directory":
				return "directory"
			case "file":
				return "file"
			case "symlink":
				return "symlink"
			default:
				return "other"
		}
	}

	private mapTarType(flag: string): TarEntryType {
		switch (flag) {
			case "0":
			case "\0":
				return "file"
			case "5":
				return "directory"
			case "2":
				return "symlink"
			default:
				return "other"
		}
	}

	private normalizeTarPath(value: string | undefined): string {
		if (!value) {
			return ""
		}

		const normalized = posixPath.normalize(value)
		let trimmed = normalized.replace(/^\.\/+/, "")
		trimmed = trimmed.replace(/^\/+/, "")
		trimmed = trimmed.replace(/\/+$/, "")

		if (!trimmed) {
			return ""
		}

		const segments = trimmed.split("/").filter((segment) => segment.length > 0)
		if (segments.some((segment) => segment === "..")) {
			return ""
		}

		return segments.join("/")
	}

	private buildTarName(prefix: string | undefined, name: string | undefined): string {
		const normalizedName = name ?? ""
		if (prefix && prefix.length > 0) {
			return `${prefix.replace(/\/+$/, "")}/${normalizedName}`
		}
		return normalizedName
	}

	private readTarField(header: Buffer, start: number, length: number): string {
		const slice = header.subarray(start, start + length)
		let end = slice.length
		for (let index = 0; index < slice.length; index += 1) {
			if (slice[index] === 0) {
				end = index
				break
			}
		}
		return slice.subarray(0, end).toString("utf8").trim()
	}

	private parsePaxHeaders(buffer: Buffer): Record<string, string> {
		const result: Record<string, string> = {}
		let offset = 0

		while (offset < buffer.length) {
			const spaceIndex = buffer.indexOf(0x20, offset)
			if (spaceIndex === -1) {
				break
			}
			const lengthString = buffer.subarray(offset, spaceIndex).toString("utf8").trim()
			const length = Number.parseInt(lengthString, 10)
			if (!Number.isFinite(length) || length <= 0) {
				break
			}

			const record = buffer.subarray(spaceIndex + 1, offset + length - 1).toString("utf8")
			const equalsIndex = record.indexOf("=")
			if (equalsIndex !== -1) {
				const key = record.slice(0, equalsIndex)
				const value = record.slice(equalsIndex + 1)
				result[key] = value
			}

			offset += length
		}

		return result
	}

	private toDockerCreateBody(options: BackendCreateOptions): Record<string, unknown> {
		const env = options.environment ? Object.entries(options.environment).map(([key, value]) => `${key}=${value}`) : undefined
		const binds = options.volumes?.map((volume) => {
			const flag = volume.readOnly ? ":ro" : ""
			return `${volume.source}:${volume.target}${flag}`
		})
		return {
			Image: options.image,
			Cmd: options.command,
			WorkingDir: options.workingDirectory,
			Env: env,
			HostConfig: binds?.length ? { Binds: binds } : undefined
		}
	}

	private parseJson<T>(response: DockerResponse): T {
		const contentType = response.headers["content-type"]
		if (!contentType || !contentType.includes("application/json")) {
			throw new BackendRequestError("Unexpected response from Docker API", response.statusCode, response.bodyText)
		}
		try {
			return JSON.parse(response.bodyText) as T
		} catch (error) {
			throw new BackendRequestError("Failed to parse Docker response", response.statusCode, {
				raw: response.bodyText,
				cause: error instanceof Error ? error.message : String(error)
			})
		}
	}

	private async request(options: DockerRequestOptions): Promise<DockerResponse> {
		const headers: http.OutgoingHttpHeaders = {
			Host: "docker",
			Accept: "application/json",
			"User-Agent": "puppycloud-backend"
		}
		if (options.headers) {
			for (const [key, value] of Object.entries(options.headers)) {
				if (typeof value !== "undefined") {
					headers[key] = value
				}
			}
		}
		let bodyBuffer: Buffer | undefined
		if (typeof options.body !== "undefined") {
			const encoded = JSON.stringify(options.body)
			bodyBuffer = Buffer.from(encoded)
			headers["Content-Type"] = headers["Content-Type"] ?? "application/json"
			headers["Content-Length"] = Buffer.byteLength(encoded)
		}
		const response = await new Promise<DockerResponse>((resolve, reject) => {
			const request = http.request(
				{
					socketPath: this.socketPath,
					method: options.method,
					path: options.path,
					headers
				},
				(res) => {
					const chunks: Buffer[] = []
					res.on("data", (chunk) => {
						chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
					})
					res.on("end", () => {
						const bodyBuffer = Buffer.concat(chunks)
						const bodyText = bodyBuffer.toString("utf8")
						const statusCode = res.statusCode ?? 0
						if (statusCode >= 400) {
							let errorDetails: DockerErrorResponse | string | undefined
							const responseContentType = res.headers["content-type"]
							if (responseContentType?.includes("application/json")) {
								try {
									errorDetails = JSON.parse(bodyText) as DockerErrorResponse
								} catch {
									errorDetails = bodyText
								}
							} else {
								errorDetails = bodyText
							}
							const message = typeof errorDetails === "object" && errorDetails !== null && "message" in errorDetails ? String((errorDetails as DockerErrorResponse).message) : bodyText || `Docker API request failed with status ${statusCode}`
							reject(new BackendRequestError(message || "Docker API request failed", statusCode, errorDetails))
							return
						}
						resolve({
							statusCode,
							headers: res.headers,
							bodyText,
							bodyBuffer
						})
					})
				}
			)
			request.setTimeout(this.requestTimeoutMs, () => {
				request.destroy(new BackendRequestError("Docker API request timed out", 504))
			})
			request.on("error", (error) => {
				reject(
					error instanceof BackendRequestError
						? error
						: new BackendRequestError(error.message, 503, {
								cause: error
							})
				)
			})
			if (bodyBuffer) {
				request.write(bodyBuffer)
			}
			request.end()
		})
		return response
	}
}

export function createDockerBackend(options?: DockerBackendOptions): DockerBackend {
	return new DockerBackend(options)
}
