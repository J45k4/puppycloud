import { ptr } from "bun:ffi"
import type { Pointer } from "bun:ffi"

const pointerToView = new Map<Pointer, NodeJS.TypedArray | DataView>()
const viewToPointer = new WeakMap<NodeJS.TypedArray | DataView, Pointer>()

export function registerPointer(view: NodeJS.TypedArray | DataView): Pointer {
	const existing = viewToPointer.get(view)
	if (existing) {
		pointerToView.set(existing, view)
		return existing
	}
	const pointerValue = ptr(view)
	pointerToView.set(pointerValue, view)
	viewToPointer.set(view, pointerValue)
	return pointerValue
}

export function unregisterPointer(pointer: Pointer): void {
	pointerToView.delete(pointer)
}

export function getRegisteredView(pointer: Pointer): NodeJS.TypedArray | DataView | undefined {
	return pointerToView.get(pointer)
}
