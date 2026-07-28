export const WINDOW_DRAG_REGION_SELECTOR = "[data-tauri-drag-region]";
export const WINDOW_DRAG_BLOCK_SELECTOR =
  "button, input, select, textarea, a, [data-no-window-drag]";

export interface WindowDragTarget {
  closest(selector: string): unknown;
}

export interface WindowDragEvent {
  button: number;
  preventDefault(): void;
  target: EventTarget | WindowDragTarget | null;
  type: string;
}

function dragTarget(target: WindowDragEvent["target"]): WindowDragTarget | null {
  return target && typeof (target as WindowDragTarget).closest === "function"
    ? (target as WindowDragTarget)
    : null;
}

export function shouldStartWindowDrag(event: WindowDragEvent): boolean {
  const target = dragTarget(event.target);
  return (
    event.type === "mousedown" &&
    event.button === 0 &&
    target !== null &&
    !target.closest(WINDOW_DRAG_BLOCK_SELECTOR) &&
    Boolean(target.closest(WINDOW_DRAG_REGION_SELECTOR))
  );
}

export async function requestWindowDrag(
  event: WindowDragEvent,
  startDragging: () => Promise<void>,
): Promise<boolean> {
  if (!shouldStartWindowDrag(event)) {
    return false;
  }
  event.preventDefault();
  await startDragging();
  return true;
}
