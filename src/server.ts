import index from "./web/index.html"
import create from "./web/create.html"
import { handleMcpRequest } from "./mcp"

Bun.serve({
    port: 3312,
    routes: {
        "/": index,
        "/create": create,
        "/mcp": {
			POST: handleMcpRequest
		}
    }
})

console.log("puppycloud running at http://localhost:3312")
