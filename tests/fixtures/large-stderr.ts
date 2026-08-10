const byteCount = Number(Bun.argv[2] ?? "1048576");

await Bun.write(Bun.stderr, "x".repeat(byteCount));

export {};
