import index from "./web/index.html"

Bun.serve({
    port: 3312,
    routes: {
        "/": index
    }
})