import { describe, expect, it, vi } from "vitest";
import {
  requestWindowDrag,
  shouldStartWindowDrag,
  WINDOW_DRAG_BLOCK_SELECTOR,
  WINDOW_DRAG_REGION_SELECTOR,
  type WindowDragEvent,
} from "../windowDrag";

function target(options: { drag?: boolean; blocked?: boolean } = {}) {
  return {
    closest(selector: string) {
      if (selector === WINDOW_DRAG_BLOCK_SELECTOR) {
        return options.blocked ? this : null;
      }
      if (selector === WINDOW_DRAG_REGION_SELECTOR) {
        return options.drag ? this : null;
      }
      return null;
    },
  };
}

function mouseEvent(
  eventTarget: ReturnType<typeof target>,
  options: Partial<Pick<WindowDragEvent, "button" | "type">> = {},
) {
  return {
    button: options.button ?? 0,
    preventDefault: vi.fn(),
    target: eventTarget,
    type: options.type ?? "mousedown",
  } satisfies WindowDragEvent;
}

describe("window titlebar drag policy", () => {
  it("calls the injected Tauri startDragging exactly once for a left-button blank drag region", async () => {
    const event = mouseEvent(target({ drag: true }));
    const startDragging = vi.fn(async () => undefined);

    await expect(requestWindowDrag(event, startDragging)).resolves.toBe(true);

    expect(startDragging).toHaveBeenCalledTimes(1);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
  });

  it("does not drag for right-button input or a target without the drag marker", async () => {
    const startDragging = vi.fn(async () => undefined);
    const rightClick = mouseEvent(target({ drag: true }), { button: 2 });
    const unmarked = mouseEvent(target());

    await expect(requestWindowDrag(rightClick, startDragging)).resolves.toBe(false);
    await expect(requestWindowDrag(unmarked, startDragging)).resolves.toBe(false);

    expect(startDragging).not.toHaveBeenCalled();
    expect(rightClick.preventDefault).not.toHaveBeenCalled();
    expect(unmarked.preventDefault).not.toHaveBeenCalled();
  });

  it.each(["pin", "minimize", "close"])(
    "does not drag from the %s control on mousedown or click",
    async () => {
      const startDragging = vi.fn(async () => undefined);
      const control = target({ drag: true, blocked: true });

      await expect(requestWindowDrag(mouseEvent(control), startDragging)).resolves.toBe(false);
      await expect(
        requestWindowDrag(mouseEvent(control, { type: "click" }), startDragging),
      ).resolves.toBe(false);

      expect(startDragging).not.toHaveBeenCalled();
    },
  );

  it("requires a drag marker and gives the no-drag marker precedence", () => {
    expect(shouldStartWindowDrag(mouseEvent(target({ drag: true })))).toBe(true);
    expect(shouldStartWindowDrag(mouseEvent(target()))).toBe(false);
    expect(shouldStartWindowDrag(mouseEvent(target({ drag: true, blocked: true })))).toBe(false);
  });
});
