import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { Buffer } from "node:buffer"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { mkdtempSync, rmSync, unlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DockerBackend } from "./docker"

function createTar(entries: Array<{ name: string; type?: "file" | "directory" | "symlink"; content?: string; linkName?: string }>): Buffer {
	const blocks: Buffer[] = []
	const blockSize = 512

	for (const entry of entries) {
		const name = entry.name
		const type = entry.type ?? "file"
		const isDirectory = type === "directory"
		const normalizedName = isDirectory && !name.endsWith("/") ? `${name}/` : name
		const contentBuffer = type === "file" ? Buffer.from(entry.content ?? "", "utf8") : Buffer.alloc(0)
		const size = contentBuffer.length
		const header = Buffer.alloc(blockSize, 0)
		header.write(normalizedName, 0, Math.min(100, Buffer.byteLength(normalizedName)))
		header.write("0000777\0", 100, "ascii")
		header.write("0000000\0", 108, "ascii")
		header.write("0000000\0", 116, "ascii")
		header.write(`${size.toString(8).padStart(11, "0")}\0`, 124, "ascii")
		const now = Math.floor(Date.now() / 1000)
		header.write(`${now.toString(8).padStart(11, "0")}\0`, 136, "ascii")
		header.write("        ", 148, "ascii")
		const typeFlag = type === "directory" ? "5" : type === "symlink" ? "2" : "0"
		header.write(typeFlag, 156, "ascii")
		if (entry.linkName) {
			header.write(entry.linkName, 157, Math.min(100, Buffer.byteLength(entry.linkName)))
		}
		header.write("ustar\0", 257, "ascii")
		header.write("00", 263, "ascii")
		let checksum = 0
		for (let index = 0; index < blockSize; index += 1) {
			checksum += header[index] ?? 0
		}
		const checksumString = checksum.toString(8).padStart(6, "0")
		header.write(checksumString, 148, "ascii")
		header.write("\0 ", 154, "ascii")
		blocks.push(header)

		if (contentBuffer.length > 0) {
			blocks.push(contentBuffer)
			const remainder = contentBuffer.length % blockSize
			if (remainder !== 0) {
				blocks.push(Buffer.alloc(blockSize - remainder, 0))
			}
		}
	}

	blocks.push(Buffer.alloc(blockSize, 0))
	blocks.push(Buffer.alloc(blockSize, 0))

	return Buffer.concat(blocks)
}

interface RecordedRequest {
	method: string
	url: string
	body: string
}

describe("DockerBackend", () => {
	const socketDir = mkdtempSync(join(tmpdir(), "docker-backend-test-"))
	const socketPath = join(socketDir, "docker.sock")
	const requests: RecordedRequest[] = []
	const backend = new DockerBackend({ socketPath, requestTimeoutMs: 5_000 })
	const containers = [
		{
			Id: "abc123",
			Names: ["/puppy"],
			Image: "node:18",
			State: "running",
			Status: "Up 5 seconds",
			Created: 1_700_000_000
		}
	]
	const packageJsonContent = '{"name":"demo"}\n'
	const fallbackFileContent = "fallback file contents\n"
	const fallbackDirectoryFileContent = "hello fallback\n"
	const prefixlessDirectoryFileContent = "prefixless top-level file\n"
	const prefixlessNestedFileContent = "prefixless nested file\n"
	const dotSegmentFileContent = "dot-segment file\n"
	const dotSegmentNestedFileContent = "dot-segment nested file\n"

	function handler(req: IncomingMessage, res: ServerResponse): void {
		const chunks: Buffer[] = []
		req.on("data", (chunk) => {
			chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
		})
		req.on("end", () => {
			const body = Buffer.concat(chunks).toString("utf8")
			requests.push({
				method: req.method ?? "GET",
				url: req.url ?? "",
				body
			})
			if (req.method === "GET" && req.url?.startsWith("/containers/json")) {
				res.setHeader("Content-Type", "application/json")
				res.end(JSON.stringify(containers))
				return
			}
			if (req.method === "POST" && req.url?.startsWith("/containers/create")) {
				res.setHeader("Content-Type", "application/json")
				res.end(
					JSON.stringify({
						Id: "new123",
						Warnings: []
					})
				)
				return
			}
			if (req.method === "POST" && req.url?.startsWith("/containers/") && req.url.endsWith("/start")) {
				res.statusCode = 204
				res.end()
				return
			}
			if (req.method === "POST" && req.url?.startsWith("/containers/new123/stop")) {
				res.statusCode = 204
				res.end()
				return
			}
			if (req.method === "DELETE" && req.url?.startsWith("/containers/new123")) {
				res.statusCode = 204
				res.end()
				return
			}
			if (req.method === "GET" && req.url?.startsWith("/containers/new123/json")) {
				res.setHeader("Content-Type", "application/json")
				res.end(JSON.stringify({ Id: "new123", Config: { Image: "node:18" } }))
				return
			}
			if (req.method === "GET" && req.url?.startsWith("/containers/new123/logs")) {
				res.setHeader("Content-Type", "text/plain")
				res.end("log-line-1\nlog-line-2\n")
				return
			}
			if (req.url?.startsWith("/containers/new123/archive?path=%2Fapp%2Fpackage.json")) {
				if (req.method === "HEAD") {
					const stat = {
						name: "package.json",
						size: Buffer.byteLength(packageJsonContent),
						mode: 33188,
						mtime: "2024-01-02T03:04:05Z"
					}
					res.setHeader("X-Docker-Container-Path-Stat", Buffer.from(JSON.stringify(stat)).toString("base64"))
					res.end()
					return
				}
				if (req.method === "GET") {
					const tar = createTar([{ name: "package.json", type: "file", content: packageJsonContent }])
					res.setHeader("Content-Type", "application/x-tar")
					res.end(tar)
					return
				}
			}
			if (req.url?.startsWith("/containers/new123/archive?path=%2Fapp")) {
				if (req.method === "HEAD") {
					const stat = {
						name: "app",
						size: 4096,
						mode: 16877,
						mtime: "2024-01-01T00:00:00Z"
					}
					res.setHeader("X-Docker-Container-Path-Stat", Buffer.from(JSON.stringify(stat)).toString("base64"))
					res.end()
					return
				}
				if (req.method === "GET") {
					const tar = createTar([
						{ name: "app", type: "directory" },
						{ name: "app/package.json", type: "file", content: packageJsonContent },
						{ name: "app/src", type: "directory" },
						{ name: "app/src/index.js", type: "file", content: "console.log('hi')\n" }
					])
					res.setHeader("Content-Type", "application/x-tar")
					res.end(tar)
					return
				}
			}
			if (req.url?.startsWith("/containers/new123/archive?path=%2Fweird-dir")) {
				if (req.method === "HEAD") {
					const stat = {
						name: "weird-dir",
						size: 0,
						mode: 0,
						mtime: "2024-02-02T00:00:00Z"
					}
					res.setHeader("X-Docker-Container-Path-Stat", Buffer.from(JSON.stringify(stat)).toString("base64"))
					res.end()
					return
				}
				if (req.method === "GET") {
					const tar = createTar([
						{ name: "weird-dir", type: "directory" },
						{
							name: "weird-dir/readme.txt",
							type: "file",
							content: fallbackDirectoryFileContent
						}
					])
					res.setHeader("Content-Type", "application/x-tar")
					res.end(tar)
					return
				}
			}
			if (req.url?.startsWith("/containers/new123/archive?path=%2Fstrange.txt")) {
				if (req.method === "HEAD") {
					const stat = {
						name: "strange.txt",
						size: Buffer.byteLength(fallbackFileContent),
						mode: 0,
						mtime: "2024-03-03T00:00:00Z"
					}
					res.setHeader("X-Docker-Container-Path-Stat", Buffer.from(JSON.stringify(stat)).toString("base64"))
					res.end()
					return
				}
				if (req.method === "GET") {
					const tar = createTar([{ name: "strange.txt", type: "file", content: fallbackFileContent }])
					res.setHeader("Content-Type", "application/x-tar")
					res.end(tar)
					return
				}
			}
			if (req.url?.startsWith("/containers/new123/archive?path=%2Fprefixless")) {
				if (req.method === "HEAD") {
					const stat = {
						name: "prefixless",
						size: 4096,
						mode: 16877,
						mtime: "2024-04-04T00:00:00Z"
					}
					res.setHeader("X-Docker-Container-Path-Stat", Buffer.from(JSON.stringify(stat)).toString("base64"))
					res.end()
					return
				}
				if (req.method === "GET") {
					const tar = createTar([
						{ name: "file.txt", type: "file", content: prefixlessDirectoryFileContent },
						{ name: "nested", type: "directory" },
						{
							name: "nested/data.txt",
							type: "file",
							content: prefixlessNestedFileContent
						}
					])
					res.setHeader("Content-Type", "application/x-tar")
					res.end(tar)
					return
				}
			}
			if (req.url?.startsWith("/containers/new123/archive?path=%2Fdotsegments")) {
				if (req.method === "HEAD") {
					const stat = {
						name: "dotsegments",
						size: 4096,
						mode: 16877,
						mtime: "2024-05-05T00:00:00Z"
					}
					res.setHeader("X-Docker-Container-Path-Stat", Buffer.from(JSON.stringify(stat)).toString("base64"))
					res.end()
					return
				}
				if (req.method === "GET") {
					const tar = createTar([
						{ name: "dotsegments", type: "directory" },
						{ name: "dotsegments/./notes.txt", type: "file", content: dotSegmentFileContent },
						{ name: "dotsegments/./config", type: "directory" },
						{ name: "dotsegments/./config/settings.json", type: "file", content: dotSegmentNestedFileContent }
					])
					res.setHeader("Content-Type", "application/x-tar")
					res.end(tar)
					return
				}
			}
			if (req.method === "POST" && req.url?.startsWith("/containers/new123/exec")) {
				res.setHeader("Content-Type", "application/json")
				res.end(JSON.stringify({ Id: "exec-123" }))
				return
			}
			if (req.method === "POST" && req.url?.startsWith("/exec/exec-123/start")) {
				res.setHeader("Content-Type", "application/vnd.docker.raw-stream")
				res.end("command-output\n")
				return
			}
			res.statusCode = 404
			res.end(JSON.stringify({ message: "not found" }))
		})
	}

	const server = createServer(handler)

	beforeAll(() => {
		try {
			unlinkSync(socketPath)
		} catch {
			// ignore
		}
		server.listen(socketPath)
	})

	afterAll(() => {
		server.close()
		try {
			unlinkSync(socketPath)
		} catch {
			// ignore cleanup race
		}
		rmSync(socketDir, { recursive: true, force: true })
	})

	it("performs container lifecycle operations", async () => {
		const listed = await backend.listInstances({ all: true })
		expect(listed).toHaveLength(1)
		expect(listed[0]).toMatchObject({
			id: "abc123",
			name: "puppy",
			image: "node:18",
			state: "running"
		})

		const created = await backend.createInstance({
			name: "new123",
			image: "node:18",
			command: ["node", "app.js"],
			environment: { NODE_ENV: "production" },
			volumes: [
				{ source: "/data", target: "/app/data" },
				{ source: "/config", target: "/app/config", readOnly: true }
			],
			workingDirectory: "/app"
		})
		expect(created).toMatchObject({ id: "new123", name: "new123", image: "node:18" })

		await backend.startInstance("new123")
		await backend.stopInstance("new123", { timeoutSeconds: 5 })
		await backend.removeInstance("new123", { force: true, removeVolumes: true })

		const inspected = await backend.inspectInstance("new123")
		expect(inspected).toHaveProperty("Config")

		const logs = await backend.getInstanceLogs("new123", { stdout: true, stderr: false, tail: 10 })
		expect(logs).toContain("log-line-1")

		const execResult = await backend.execInstanceCommand("new123", ["/bin/sh", "-c", "echo ok"])
		expect(execResult.output).toContain("command-output")

		const directoryInfo = await backend.getInstancePath("new123", "/app")
		expect(directoryInfo.type).toBe("directory")
		expect(directoryInfo.path).toBe("/app")
		expect(directoryInfo.entries).toEqual([
			{
				name: "src",
				type: "directory",
				size: 0,
				modifiedAt: expect.any(String),
				linkTarget: undefined
			},
			{
				name: "package.json",
				type: "file",
				size: Buffer.byteLength(packageJsonContent),
				modifiedAt: expect.any(String),
				linkTarget: undefined
			}
		])

		const fileInfo = await backend.getInstancePath("new123", "/app/package.json")
		expect(fileInfo.type).toBe("file")
		expect(fileInfo.content).toBe(Buffer.from(packageJsonContent, "utf8").toString("base64"))
		expect(fileInfo.encoding).toBe("base64")
		expect(fileInfo.size).toBe(Buffer.byteLength(packageJsonContent))

		expect(requests.map((entry) => entry.method)).toEqual(["GET", "POST", "POST", "POST", "DELETE", "GET", "GET", "POST", "POST", "HEAD", "GET", "HEAD", "GET"])

		const createRequest = requests.find((entry) => entry.url.startsWith("/containers/create"))
		expect(createRequest).toBeDefined()
		const parsedBody = createRequest ? JSON.parse(createRequest.body) : {}
		expect(parsedBody).toMatchObject({
			Image: "node:18",
			Cmd: ["node", "app.js"],
			Env: ["NODE_ENV=production"],
			WorkingDir: "/app"
		})
		expect(parsedBody.HostConfig.Binds).toContain("/data:/app/data")
		expect(parsedBody.HostConfig.Binds).toContain("/config:/app/config:ro")
	})

	it("falls back to archive entries when Docker omits directory mode", async () => {
		const info = await backend.getInstancePath("new123", "/weird-dir")
		expect(info.type).toBe("directory")
		expect(info.path).toBe("/weird-dir")
		expect(info.entries).toEqual([
			{
				name: "readme.txt",
				type: "file",
				size: Buffer.byteLength(fallbackDirectoryFileContent),
				modifiedAt: expect.any(String),
				linkTarget: undefined
			}
		])
	})

	it("lists directory entries when Docker omits directory prefixes", async () => {
		const info = await backend.getInstancePath("new123", "/prefixless")
		expect(info.type).toBe("directory")
		expect(info.path).toBe("/prefixless")
		expect(info.entries).toEqual([
			{
				name: "nested",
				type: "directory",
				size: 0,
				modifiedAt: expect.any(String),
				linkTarget: undefined
			},
			{
				name: "file.txt",
				type: "file",
				size: Buffer.byteLength(prefixlessDirectoryFileContent),
				modifiedAt: expect.any(String),
				linkTarget: undefined
			}
		])
	})

	it("lists directory entries when Docker includes dot segments", async () => {
		const info = await backend.getInstancePath("new123", "/dotsegments")
		expect(info.type).toBe("directory")
		expect(info.path).toBe("/dotsegments")
		expect(info.entries).toEqual([
			{
				name: "config",
				type: "directory",
				size: 0,
				modifiedAt: expect.any(String),
				linkTarget: undefined
			},
			{
				name: "notes.txt",
				type: "file",
				size: Buffer.byteLength(dotSegmentFileContent),
				modifiedAt: expect.any(String),
				linkTarget: undefined
			}
		])
	})

	it("falls back to archive entries when Docker omits file mode", async () => {
		const info = await backend.getInstancePath("new123", "/strange.txt")
		expect(info.type).toBe("file")
		expect(info.path).toBe("/strange.txt")
		expect(info.encoding).toBe("base64")
		expect(info.size).toBe(Buffer.byteLength(fallbackFileContent))
		const decoded = Buffer.from(info.content ?? "", "base64").toString("utf8")
		expect(decoded).toBe(fallbackFileContent)
	})
})
