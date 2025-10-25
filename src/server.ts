import index from "./web/index.html"
import create from "./web/create.html"
import { handleMcpRequest } from "./mcp"
import { createDockerBackend } from "./backends/docker"

const dockerBackend = createDockerBackend()

async function handleCreateContainer(req: Request): Promise<Response> {
	try {
		const body = await req.json()

		if (!body.image) {
			return Response.json({ error: "Image is required" }, { status: 400 })
		}

		const createOptions = {
			image: body.image,
			name: body.name || undefined,
			command: body.command ? (Array.isArray(body.command) ? body.command : body.command.split(" ")) : undefined,
			environment: body.environment || undefined,
			workingDirectory: body.workingDirectory || undefined
		}

		await dockerBackend.pullImage(body.image)
		const instance = await dockerBackend.createInstance(createOptions)
		await dockerBackend.startInstance(instance.id)

		return Response.json({
			success: true,
			instance
		})
	} catch (error) {
		console.error("Error creating container:", error)
		return Response.json(
			{
				error: error instanceof Error ? error.message : "Failed to create container"
			},
			{ status: 500 }
		)
	}
}

Bun.serve({
	port: 3312,
	routes: {
		"/": index,
		"/create": create,
		"/api/containers": {
			POST: handleCreateContainer
		},
		"/mcp": {
			POST: handleMcpRequest
		}
	}
})

console.log("puppycloud running at http://localhost:3312")
