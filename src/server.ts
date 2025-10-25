import index from "./web/index.html"
import create from "./web/create.html"
import containerPage from "./web/container.html"
import { handleMcpRequest } from "./mcp"
import { createDockerBackend } from "./backends/docker"
import { BackendRequestError } from "./backends/errors"

const dockerBackend = createDockerBackend()

function asRecord(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object") {
		return undefined
	}

	return value as Record<string, unknown>
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined
}

function asNumber(value: unknown): number | undefined {
	return typeof value === "number" ? value : undefined
}

function asStringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) {
		return undefined
	}

	const result: string[] = []
	for (const entry of value) {
		if (typeof entry === "string") {
			result.push(entry)
		}
	}

	return result.length > 0 ? result : undefined
}

function asStringRecord(value: unknown): Record<string, string> | undefined {
	const record = asRecord(value)
	if (!record) {
		return undefined
	}

	const result: Record<string, string> = {}
	for (const [key, entry] of Object.entries(record)) {
		if (typeof entry === "string") {
			result[key] = entry
		}
	}

	return Object.keys(result).length > 0 ? result : undefined
}

async function handleListContainers(_req: Request): Promise<Response> {
	try {
		console.log("📋 Listing containers")
		const containers = await dockerBackend.listInstances({ all: true })
		console.log(`✅ Found ${containers.length} containers`)
		return Response.json({ containers })
	} catch (error) {
		console.error("❌ Error listing containers:", error)
		return Response.json(
			{
				error: error instanceof Error ? error.message : "Failed to list containers"
			},
			{ status: 500 }
		)
	}
}

async function handleCreateContainer(req: Request): Promise<Response> {
	try {
		const rawBody = await req.json()
		console.log("📥 Received container creation request:", rawBody)

		const body = asRecord(rawBody)
		if (!body) {
			console.log("❌ Validation failed: Body must be an object")
			return Response.json({ error: "Request body must be an object" }, { status: 400 })
		}

		const image = asString(body.image)
		if (!image) {
			console.log("❌ Validation failed: Image is required")
			return Response.json({ error: "Image is required" }, { status: 400 })
		}

		const name = asString(body.name)
		const commandValue = body.command
		let command: string[] | undefined
		if (Array.isArray(commandValue)) {
			const normalized: string[] = []
			for (const part of commandValue) {
				if (typeof part === "string" && part.length > 0) {
					normalized.push(part)
				}
			}
			command = normalized.length > 0 ? normalized : undefined
		} else if (typeof commandValue === "string") {
			const parts = commandValue
				.split(" ")
				.map((segment) => segment.trim())
				.filter((segment) => segment.length > 0)
			command = parts.length > 0 ? parts : undefined
		}

		const environment = asStringRecord(body.environment)
		const workingDirectory = asString(body.workingDirectory)

		const createOptions = {
			image,
			name: name || undefined,
			command,
			environment,
			workingDirectory
		}

		console.log(`🔄 Pulling image: ${image}`)
		await dockerBackend.pullImage(image)
		console.log(`✅ Image pulled successfully: ${image}`)

		console.log(`🔨 Creating container${name ? ` with name: ${name}` : ""}`)
		const instance = await dockerBackend.createInstance(createOptions)
		console.log(`✅ Container created with ID: ${instance.id}`)

		console.log(`▶️  Starting container: ${instance.id}`)
		await dockerBackend.startInstance(instance.id)
		console.log(`✅ Container started successfully: ${instance.id}`)

		console.log("🎉 Container creation completed successfully")
		return Response.json({
			success: true,
			instance
		})
	} catch (error) {
		console.error("❌ Error creating container:", error)
		return Response.json(
			{
				error: error instanceof Error ? error.message : "Failed to create container"
			},
			{ status: 500 }
		)
	}
}

async function handleGetContainerDetails(req: Request): Promise<Response> {
	const url = new URL(req.url)
	const id = url.searchParams.get("id")

	if (!id) {
		return Response.json({ error: "Container id is required" }, { status: 400 })
	}

	try {
		console.log(`🔍 Inspecting container: ${id}`)
		const details = await dockerBackend.inspectInstance(id)

		const containerId = asString(details.Id) ?? id
		const rawName = asString(details.Name)
		const name = rawName ? rawName.replace(/^\//, "") : undefined
		const createdAt = asString(details.Created)

		const config = asRecord(details.Config)
		const image = config ? asString(config.Image) : undefined
		const command = config ? (asStringArray(config.Cmd) ?? asString(config.Cmd)) : undefined
		const environment = config ? asStringArray(config.Env) : undefined
		const labelsRecord = config ? asRecord(config.Labels) : undefined
		const labels: Record<string, string> = {}
		if (labelsRecord) {
			for (const [key, value] of Object.entries(labelsRecord)) {
				if (typeof value === "string") {
					labels[key] = value
				}
			}
		}

		const stateInfo = asRecord(details.State)
		const state = stateInfo ? asString(stateInfo.Status) : undefined
		const startedAt = stateInfo ? asString(stateInfo.StartedAt) : undefined
		const finishedAt = stateInfo ? asString(stateInfo.FinishedAt) : undefined
		const restartCount = stateInfo ? asNumber(stateInfo.RestartCount) : undefined
		const healthInfo = stateInfo ? asRecord(stateInfo.Health) : undefined
		const healthStatus = healthInfo ? asString(healthInfo.Status) : undefined

		const networkSettings = asRecord(details.NetworkSettings)
		const portsRecord = networkSettings ? asRecord(networkSettings.Ports) : undefined
		const ports: Array<{ containerPort: string; hostIp?: string; hostPort?: string }> = []
		if (portsRecord) {
			for (const [containerPort, bindings] of Object.entries(portsRecord)) {
				if (Array.isArray(bindings) && bindings.length > 0) {
					for (const binding of bindings) {
						const bindingRecord = asRecord(binding)
						if (bindingRecord) {
							ports.push({
								containerPort,
								hostIp: asString(bindingRecord.HostIp),
								hostPort: asString(bindingRecord.HostPort)
							})
						}
					}
				} else {
					ports.push({ containerPort })
				}
			}
		}

		const mountsRaw = Array.isArray(details.Mounts) ? details.Mounts : undefined
		const mounts: Array<{ source?: string; destination?: string; mode?: string; type?: string; rw?: boolean }> = []
		if (mountsRaw) {
			for (const mount of mountsRaw) {
				const mountRecord = asRecord(mount)
				if (!mountRecord) {
					continue
				}

				mounts.push({
					source: asString(mountRecord.Source),
					destination: asString(mountRecord.Destination),
					mode: asString(mountRecord.Mode),
					type: asString(mountRecord.Type),
					rw: mountRecord.RW === true
				})
			}
		}

		const normalizedPorts = ports.length > 0 ? ports : undefined
		const normalizedMounts = mounts.length > 0 ? mounts : undefined

		return Response.json({
			container: {
				id: containerId,
				name,
				image,
				command,
				createdAt,
				startedAt,
				finishedAt,
				restartCount,
				state,
				healthStatus,
				environment,
				labels: Object.keys(labels).length > 0 ? labels : undefined,
				ports: normalizedPorts,
				mounts: normalizedMounts,
				raw: details
			}
		})
	} catch (error) {
		console.error("❌ Error inspecting container:", error)
		if (error instanceof BackendRequestError && error.statusCode === 404) {
			return Response.json({ error: "Container not found" }, { status: 404 })
		}

		return Response.json({ error: error instanceof Error ? error.message : "Failed to inspect container" }, { status: 500 })
	}
}

Bun.serve({
	port: 3312,
	routes: {
		"/": index,
		"/create": create,
		"/containers": containerPage,
		"/api/containers": {
			GET: handleListContainers,
			POST: handleCreateContainer
		},
		"/api/container": {
			GET: handleGetContainerDetails
		},
		"/mcp": {
			POST: handleMcpRequest
		}
	}
})

console.log("puppycloud running at http://localhost:3312")
