export interface BackendInstanceInfo {
	id: string
	name?: string
	image?: string
	state?: string
	status?: string
	createdAt?: number
}

export interface BackendListOptions {
	all?: boolean
}

export interface BackendCreateOptions {
	image: string
	name?: string
	command?: string[]
	environment?: Record<string, string>
	volumes?: Array<{
		source: string
		target: string
		readOnly?: boolean
	}>
	workingDirectory?: string
}

export interface BackendStopOptions {
	timeoutSeconds?: number
}

export interface BackendRemoveOptions {
	force?: boolean
	removeVolumes?: boolean
}

export interface BackendLogOptions {
	stdout?: boolean
	stderr?: boolean
	since?: number
	tail?: number | "all"
}

export interface BackendExecOptions {
	workingDirectory?: string
}

export interface BackendExecResult {
	output: string
}

export type BackendPathType = "file" | "directory" | "symlink" | "other"

export interface BackendFileEntry {
	name: string
	type: BackendPathType
	size?: number
	modifiedAt?: string
	linkTarget?: string
}

export interface BackendPathInfo {
	path: string
	type: BackendPathType
	size?: number
	modifiedAt?: string
	linkTarget?: string
	encoding?: "base64"
	content?: string
	entries?: BackendFileEntry[]
}

export interface Backend {
	listInstances(options?: BackendListOptions): Promise<BackendInstanceInfo[]>
	createInstance(options: BackendCreateOptions): Promise<BackendInstanceInfo>
	startInstance(id: string): Promise<void>
	stopInstance(id: string, options?: BackendStopOptions): Promise<void>
	removeInstance(id: string, options?: BackendRemoveOptions): Promise<void>
	inspectInstance(id: string): Promise<Record<string, unknown>>
	getInstanceLogs(id: string, options?: BackendLogOptions): Promise<string>
	execInstanceCommand(id: string, command: string[], options?: BackendExecOptions): Promise<BackendExecResult>
	getInstancePath(id: string, path: string): Promise<BackendPathInfo>
}
