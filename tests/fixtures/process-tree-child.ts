const markerPath = Bun.argv[2];

if (markerPath === undefined) {
  throw new Error("Marker path is required");
}

process.on("SIGTERM", () => {
  void Bun.write(markerPath, "terminated").finally(() => process.exit(0));
});

setInterval(() => undefined, 1_000);
