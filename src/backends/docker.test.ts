import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { Buffer } from "node:buffer"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { mkdtempSync, rmSync, unlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DockerBackend } from "./docker"

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
			if (req.method === "POST" && req.url?.endsWith("/start")) {
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

		expect(requests.map((entry) => entry.method)).toEqual(["GET", "POST", "POST", "POST", "DELETE", "GET", "GET"])

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
})
