export type VirtualMachineState = "unknown" | "noState" | "running" | "blocked" | "paused" | "shutdown" | "shutoff" | "crashed" | "suspended"

export interface VirtualMachineInfo {
	id: number | null
	name: string
	uuid: string
	state: VirtualMachineState
	stateReason?: number
	isActive: boolean
	isPersistent: boolean
	autostart?: boolean
}

export interface VirtualMachineListOptions {
	includeActive?: boolean
	includeInactive?: boolean
}

export interface VirtualMachineCreateOptions {
	xml: string
	persistent?: boolean
	start?: boolean
	autostart?: boolean
}

export interface VirtualMachineMountTarget {
	path: string
}

export interface VirtualMachineNfsMountSource {
	host: string
	path: string
	port?: number
}

export interface VirtualMachineNfsMountOptions {
	type: "nfs"
	source: VirtualMachineNfsMountSource
	target: VirtualMachineMountTarget
	readonly?: boolean
}

export type VirtualMachineMountOptions = VirtualMachineNfsMountOptions

export interface VirtualMachineNfsMountInfo {
	type: "nfs"
	source: VirtualMachineNfsMountSource
	target: VirtualMachineMountTarget
	readonly: boolean
}

export type VirtualMachineMountInfo = VirtualMachineNfsMountInfo

export type VirtualMachineReference = { uuid: string } | { name: string } | { id: number }

export interface VirtualMachineBackend {
	listVirtualMachines(options?: VirtualMachineListOptions): Promise<VirtualMachineInfo[]>
	getVirtualMachine(reference: VirtualMachineReference): Promise<VirtualMachineInfo>
	createVirtualMachine(options: VirtualMachineCreateOptions): Promise<VirtualMachineInfo>
	startVirtualMachine(reference: VirtualMachineReference): Promise<void>
	shutdownVirtualMachine(reference: VirtualMachineReference): Promise<void>
	destroyVirtualMachine(reference: VirtualMachineReference): Promise<void>
	undefineVirtualMachine(reference: VirtualMachineReference): Promise<void>
	setAutostart(reference: VirtualMachineReference, autostart: boolean): Promise<void>
	listVirtualMachineMounts(reference: VirtualMachineReference): Promise<VirtualMachineMountInfo[]>
	attachVirtualMachineMount(reference: VirtualMachineReference, mount: VirtualMachineMountOptions): Promise<void>
	detachVirtualMachineMount(reference: VirtualMachineReference, targetPath: string): Promise<void>
	close(): Promise<void>
}
