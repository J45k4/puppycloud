import http from "node:http"
import { Buffer } from "node:buffer"
import { URLSearchParams } from "node:url"
import type { Backend, BackendCreateOptions, BackendInstanceInfo, BackendListOptions, BackendLogOptions, BackendRemoveOptions, BackendStopOptions } from "./base"
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

	async pullImage(image: string): Promise<void> {
		const params = new URLSearchParams()
		params.set("fromImage", image)
		await this.request({
			method: "POST",
			path: `/images/create?${params.toString()}`
		})
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
						const bodyText = Buffer.concat(chunks).toString("utf8")
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
							bodyText
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
