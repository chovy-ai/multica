type ConsoleLike = {
  error: (...args: unknown[]) => void;
};

const reactRenderLoopErrorPattern =
  /maximum update depth exceeded|too many re-renders|react limits the number of renders|react limits the number of nested updates/iu;

export function installReactRenderLoopConsoleTrap({
  console: targetConsole
}: {
  console: ConsoleLike;
}): () => void {
  const originalError = targetConsole.error;

  targetConsole.error = (...args: unknown[]) => {
    originalError(...args);

    const message = args.map(formatConsoleArg).join(" ");
    if (!reactRenderLoopErrorPattern.test(message)) {
      return;
    }

    throw new Error(
      [
        "React render loop detected from console.error.",
        "The original React diagnostic was:",
        message
      ].join("\n")
    );
  };

  return () => {
    targetConsole.error = originalError;
  };
}

function formatConsoleArg(arg: unknown): string {
  if (arg instanceof Error) {
    return `${arg.name}: ${arg.message}\n${arg.stack ?? ""}`;
  }
  if (typeof arg === "string") {
    return arg;
  }
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}
