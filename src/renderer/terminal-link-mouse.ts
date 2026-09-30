import type { Terminal } from "@xterm/xterm";

// xterm supports default/UTF-8, SGR and urxvt mouse encodings.
const MOUSE_REPORT = /^(?:\[M[\s\S]{3}|\[<\d+;\d+;\d+[mM]|\[\d+;\d+;\d+M)$/u;
type TerminalMouseEvent = Parameters<NonNullable<Terminal["options"]["linkHandler"]>["activate"]>[0];

interface LinkGesture {
  x: number;
  y: number;
  dragged: boolean;
  released: boolean;
  pending: string[];
}

/** Keep OSC 8 link clicks out of the CLI, while preserving CLI drag gestures. */
export class TerminalLinkMouse {
  private gesture: LinkGesture | undefined;
  private removeListeners: (() => void) | undefined;

  constructor(private readonly send: (data: string) => void) {}

  attach(terminal: Terminal): void {
    const element = terminal.element;
    if (!element || this.removeListeners) return;
    const document = element.ownerDocument;
    const down = (event: TerminalMouseEvent): void => {
      if (event.button !== 0) return;
      this.gesture = undefined;
      const screen = element.querySelector(".xterm-screen");
      if (event.target instanceof window.Node && screen?.contains(event.target) && screen.classList.contains("xterm-cursor-pointer")) {
        this.gesture = { x: event.clientX, y: event.clientY, dragged: false, released: false, pending: [] };
      }
    };
    const startDrag = (): void => {
      const gesture = this.gesture;
      if (!gesture || gesture.dragged || gesture.released) return;
      gesture.dragged = true;
      // Deliver the held press before xterm emits the movement/release report.
      for (const data of gesture.pending) this.send(data);
      gesture.pending = [];
    };
    const move = (event: TerminalMouseEvent): void => {
      const gesture = this.gesture;
      if (gesture && (Math.abs(event.clientX - gesture.x) >= 4 || Math.abs(event.clientY - gesture.y) >= 4)) {
        startDrag();
      }
    };
    const up = (event: TerminalMouseEvent): void => {
      if (event.button !== 0 || !this.gesture) return;
      move(event);
      const gesture = this.gesture;
      gesture.released = true;
      // Both link activation on the screen and PTY release on document run in
      // the bubble phase. Retain ownership until both have finished.
      window.setTimeout(() => {
        if (this.gesture === gesture) this.gesture = undefined;
      }, 0);
    };
    const cancel = (): void => { this.gesture = undefined; };
    element.addEventListener("mousedown", down, true);
    document.addEventListener("mousemove", move, true);
    document.addEventListener("mouseup", up, true);
    element.addEventListener("wheel", startDrag, true);
    document.defaultView?.addEventListener("blur", cancel);
    this.removeListeners = () => {
      element.removeEventListener("mousedown", down, true);
      document.removeEventListener("mousemove", move, true);
      document.removeEventListener("mouseup", up, true);
      element.removeEventListener("wheel", startDrag, true);
      document.defaultView?.removeEventListener("blur", cancel);
    };
  }

  forward(data: string): void {
    if (this.gesture && !this.gesture.dragged && data.startsWith("\x1b") && MOUSE_REPORT.test(data.slice(1))) {
      this.gesture.pending.push(data);
      return;
    }
    this.send(data);
  }

  shouldActivate(event: TerminalMouseEvent): boolean {
    return event.button === 0 && !this.gesture?.dragged;
  }

  dispose(): void {
    this.removeListeners?.();
    this.removeListeners = undefined;
    this.gesture = undefined;
  }
}
