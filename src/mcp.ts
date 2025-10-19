export interface JsonRpcRequest {
    jsonrpc: "2.0"
    id: number | string | null
    method: string
    params?: unknown
}

export interface JsonRpcSuccess<T> {
    jsonrpc: "2.0"
    id: number | string | null
    result: T
}

export interface JsonRpcError {
    jsonrpc: "2.0"
    id: number | string | null
    error: {
        code: number
        message: string
        data?: unknown
    }
}

type JsonRpcResponse<T> = JsonRpcSuccess<T> | JsonRpcError

interface InitializeResult {
    protocolVersion: string
    serverInfo: {
        name: string
        version: string
    }
    capabilities: {
        resources: {
            list: boolean
            read: boolean
        }
    }
}

export interface McpResource {
    uri: string
    name: string
    description: string
    mimeType: string
}

interface ListResourcesResult {
    resources: McpResource[]
}

interface ReadResourceParams {
    uri: string
}

interface ReadResourceResult {
    contents: Array<{
        uri: string
        mimeType: string
        text?: string
    }>
}

const SERVER_INFO = {
    name: "puppycloud-mcp",
    version: "1.0.0"
}

const PROTOCOL_VERSION = "0.1.0"

const RESOURCES: McpResource[] = [
    {
        uri: "puppycloud://resources/welcome",
        name: "Welcome",
        description: "Provides a short overview of PuppyCloud services.",
        mimeType: "text/markdown"
    }
]

const RESOURCE_CONTENT: Record<string, string> = {
    "puppycloud://resources/welcome": `# Welcome to PuppyCloud\n\nPuppyCloud provides an adorable cloud hosting platform for canine-inspired projects.\n\n- **Create** and share profiles for pups.\n- **Organize** play dates and puppy meetups.\n- **Celebrate** every wag with a vibrant community.\n`
}

function createSuccessResponse<T>(id: number | string | null, result: T): JsonRpcSuccess<T> {
    return {
        jsonrpc: "2.0",
        id,
        result
    }
}

function createErrorResponse(id: number | string | null, code: number, message: string, data?: unknown): JsonRpcError {
    return {
        jsonrpc: "2.0",
        id,
        error: {
            code,
            message,
            data
        }
    }
}

async function parseJsonBody(request: Request): Promise<JsonRpcRequest | JsonRpcError> {
    try {
        const body = (await request.json()) as JsonRpcRequest
        return body
    } catch (error) {
        return createErrorResponse(null, -32700, "Invalid JSON in request body.", {
            message: error instanceof Error ? error.message : String(error)
        })
    }
}

function isJsonRpcRequest(payload: JsonRpcRequest | JsonRpcError): payload is JsonRpcRequest {
    return typeof payload === "object" && payload !== null && "jsonrpc" in payload && (payload as JsonRpcRequest).jsonrpc === "2.0" && "method" in payload
}

function handleInitialize(request: JsonRpcRequest): JsonRpcResponse<InitializeResult> {
    return createSuccessResponse(request.id ?? null, {
        protocolVersion: PROTOCOL_VERSION,
        serverInfo: SERVER_INFO,
        capabilities: {
            resources: {
                list: true,
                read: true
            }
        }
    })
}

function handleListResources(request: JsonRpcRequest): JsonRpcResponse<ListResourcesResult> {
    return createSuccessResponse(request.id ?? null, {
        resources: RESOURCES
    })
}

function handleReadResource(request: JsonRpcRequest): JsonRpcResponse<ReadResourceResult> {
    const params = request.params as ReadResourceParams | undefined

    if (!params || typeof params.uri !== "string") {
        return createErrorResponse(request.id ?? null, -32602, "Missing or invalid resource URI.")
    }

    const content = RESOURCE_CONTENT[params.uri]

    if (!content) {
        return createErrorResponse(request.id ?? null, -32601, `Resource not found: ${params.uri}`)
    }

    return createSuccessResponse(request.id ?? null, {
        contents: [
            {
                uri: params.uri,
                mimeType: "text/markdown",
                text: content
            }
        ]
    })
}

function handlePing(request: JsonRpcRequest): JsonRpcResponse<{ ok: boolean }> {
    return createSuccessResponse(request.id ?? null, { ok: true })
}

function createMethodNotFoundResponse(request: JsonRpcRequest): JsonRpcError {
    return createErrorResponse(request.id ?? null, -32601, `Unknown method: ${request.method}`)
}

export async function handleMcpRequest(request: Request): Promise<Response> {
    if (request.method !== "POST") {
        return new Response(JSON.stringify(createErrorResponse(null, -32600, "Only POST requests are supported for MCP interactions.")), {
            status: 405,
            headers: {
                "Content-Type": "application/json",
                Allow: "POST"
            }
        })
    }

    const payload = await parseJsonBody(request)

    if (!isJsonRpcRequest(payload)) {
        return new Response(JSON.stringify(payload), {
            status: 400,
            headers: {
                "Content-Type": "application/json"
            }
        })
    }

    let response: JsonRpcResponse<unknown>

    switch (payload.method) {
        case "initialize": {
            response = handleInitialize(payload)
            break
        }
        case "list_resources": {
            response = handleListResources(payload)
            break
        }
        case "read_resource": {
            response = handleReadResource(payload)
            break
        }
        case "ping": {
            response = handlePing(payload)
            break
        }
        default: {
            response = createMethodNotFoundResponse(payload)
        }
    }

    return new Response(JSON.stringify(response), {
        status: "error" in response ? 400 : 200,
        headers: {
            "Content-Type": "application/json"
        }
    })
}
