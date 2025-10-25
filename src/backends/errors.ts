export class BackendError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "BackendError"
	}
}

export class BackendRequestError extends BackendError {
	readonly statusCode: number
	readonly details?: unknown

	constructor(message: string, statusCode: number, details?: unknown) {
		super(message)
		this.name = "BackendRequestError"
		this.statusCode = statusCode
		this.details = details
	}
}
