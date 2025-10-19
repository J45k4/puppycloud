import index from "./web/index.html"
import create from "./web/create.html"

Bun.serve({
	port: 3312,
	routes: {
		"/": index,
		"/create": create
	}
})

console.log("puppycloud running at http://localhost:3312")
