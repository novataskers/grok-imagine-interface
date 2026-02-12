"use client";

export default function Home() {
  return (
    <div style={{ width: "100vw", height: "100vh", margin: 0, padding: 0, overflow: "hidden" }}>
      <iframe
        src="https://grok.com/imagine"
        style={{
          width: "100%",
          height: "100%",
          border: "none",
        }}
        allow="clipboard-write; clipboard-read"
      />
    </div>
  );
}
