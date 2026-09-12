import {
  type DragEvent as ReactDragEvent,
  useEffect,
  useLayoutEffect,
  useRef,
} from "react";

import { formatDroppedFilePaths } from "../../shared/clipboard";

import { cockpitApi } from "../bridge";
import { scheduleTerminalFitAfterReveal } from "../terminal-behavior";
import { terminalRegistry } from "../terminal-registry";

interface TerminalViewProps {
  active: boolean;
  /** このペインで動く CLI。改行として送るバイト列の選択に使う。 */
  command: string;
  onFocus: () => void;
  sessionId: string;
  visible: boolean;
}

let windowFileDropGuardUsers = 0;

function isFileDrag(
  dataTransfer: globalThis.DataTransfer | null,
): boolean {
  return (
    dataTransfer !== null &&
    (dataTransfer.files.length > 0 ||
      Array.from(dataTransfer.types).includes("Files"))
  );
}

function preventWindowFileNavigation(event: globalThis.DragEvent): void {
  if (isFileDrag(event.dataTransfer)) {
    event.preventDefault();
  }
}

function acquireWindowFileDropGuard(): () => void {
  windowFileDropGuardUsers += 1;
  if (windowFileDropGuardUsers === 1) {
    window.addEventListener("dragover", preventWindowFileNavigation);
    window.addEventListener("drop", preventWindowFileNavigation);
  }

  return () => {
    windowFileDropGuardUsers -= 1;
    if (windowFileDropGuardUsers === 0) {
      window.removeEventListener("dragover", preventWindowFileNavigation);
      window.removeEventListener("drop", preventWindowFileNavigation);
    }
  };
}

export function TerminalView({
  active,
  command,
  onFocus,
  sessionId,
  visible,
}: TerminalViewProps) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => acquireWindowFileDropGuard(), []);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return;
    }

    const controller = terminalRegistry.ensure(sessionId, command);
    controller.attach(host);
    const resizeObserver = new ResizeObserver(() => {
      requestAnimationFrame(() => {
        controller.fit(host);
      });
    });
    resizeObserver.observe(host);

    return () => {
      resizeObserver.disconnect();
      controller.detach(host);
    };
  }, [command, sessionId]);

  useEffect(() => {
    const host = hostRef.current;
    if (!visible || !host) {
      return;
    }

    const controller = terminalRegistry.ensure(sessionId);
    return scheduleTerminalFitAfterReveal({
      cancelFrame: (frameId) => cancelAnimationFrame(frameId),
      getHostSize: () => ({
        height: host.clientHeight,
        width: host.clientWidth,
      }),
      onReady: () => {
        // 非表示解除後の確定サイズを pty に必ず再通知する。
        controller.fit(host, true);
      },
      requestFrame: (callback) => requestAnimationFrame(callback),
    });
  }, [sessionId, visible]);

  useEffect(() => {
    if (!active) {
      return;
    }

    const controller = terminalRegistry.ensure(sessionId);
    const frame = requestAnimationFrame(() => {
      controller.focus();
    });

    return () => cancelAnimationFrame(frame);
  }, [active, sessionId]);

  const handleDragOver = (event: ReactDragEvent<HTMLDivElement>): void => {
    if (!isFileDrag(event.dataTransfer)) {
      return;
    }

    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  };

  const handleDrop = (event: ReactDragEvent<HTMLDivElement>): void => {
    if (!isFileDrag(event.dataTransfer)) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    const filePaths = Array.from(event.dataTransfer.files, (file) => {
      try {
        return cockpitApi.getPathForFile(file);
      } catch {
        return "";
      }
    });
    const input = formatDroppedFilePaths(filePaths);
    if (input) {
      cockpitApi.writeSession({
        data: input,
        sessionId,
      });
    }

    onFocus();
    terminalRegistry.ensure(sessionId).focus();
  };

  return (
    <div
      className="terminal-host"
      data-testid={`terminal-${sessionId}`}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      onFocusCapture={onFocus}
      onMouseDown={onFocus}
      ref={hostRef}
    />
  );
}
