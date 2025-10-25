import index from "./web/index.html"
import create from "./web/create.html"
import { handleMcpRequest } from "./mcp"
import { createDockerBackend } from "./backends/docker"

const dockerBackend = createDockerBackend()

async function handleCreateContainer(req: Request): Promise<Response> {
	try {
		const body = await req.json()
		console.log("📥 Received container creation request:", body)

		if (!body.image) {
			console.log("❌ Validation failed: Image is required")
			return Response.json({ error: "Image is required" }, { status: 400 })
		}

		const createOptions = {
			image: body.image,
			name: body.name || undefined,
			command: body.command ? (Array.isArray(body.command) ? body.command : body.command.split(" ")) : undefined,
			environment: body.environment || undefined,
			workingDirectory: body.workingDirectory || undefined
		}

		console.log(`🔄 Pulling image: ${body.image}`)
		await dockerBackend.pullImage(body.image)
		console.log(`✅ Image pulled successfully: ${body.image}`)

		console.log(`🔨 Creating container${body.name ? ` with name: ${body.name}` : ""}`)
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
