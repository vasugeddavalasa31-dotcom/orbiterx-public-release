import { describe, expect, it } from "vitest"
import {
  splitChainedCommandWithOutputs,
  synthesizeSegmentInput,
  segmentToolName,
} from "./shell-command-split"

describe("splitChainedCommandWithOutputs", () => {
  it("returns null for a single generic command (no lane verb)", () => {
    expect(
      splitChainedCommandWithOutputs(
        "/bin/zsh -lc 'python3 calculator.py'",
        null
      )
    ).toBeNull()
    expect(
      splitChainedCommandWithOutputs("/bin/zsh -lc 'wc -l f'", null)
    ).toBeNull()
  })

  it("classifies a single unclassified read as one read card", () => {
    const segments = splitChainedCommandWithOutputs(
      "/bin/zsh -lc 'head -n 20 f'",
      "line1\nline2\n"
    )
    expect(segments).not.toBeNull()
    expect(segments!.map((s) => s.kind)).toEqual(["read"])
    expect(segments![0].output).toBe("line1\nline2\n")
  })

  it("classifies a single find listing as one list card", () => {
    const segments = splitChainedCommandWithOutputs(
      '/bin/zsh -lc \'find /Volumes/vame/orbiterx-test-workspace -name "calculator.py" -not -path "*/node_modules/*" 2>/dev/null\'',
      "/Volumes/vame/orbiterx-test-workspace/calculator.py\n"
    )
    expect(segments).not.toBeNull()
    expect(segments!.map((s) => s.kind)).toEqual(["list"])
    expect(segments![0].output).toContain("calculator.py")
  })

  it("splits head && echo && tail into two reads with per-segment output", () => {
    const command =
      "/bin/zsh -lc 'head -n 20 f && echo \"----TAIL----\" && tail -n 10 f'"
    const output = "line1\nline2\n----TAIL----\nline9\nline10\n"
    const segments = splitChainedCommandWithOutputs(command, output)
    expect(segments).not.toBeNull()
    expect(segments!.map((s) => s.kind)).toEqual(["read", "read"])
    expect(segments![0].command).toBe("head -n 20 f")
    expect(segments![0].output).toBe("line1\nline2\n")
    expect(segments![1].command).toBe("tail -n 10 f")
    expect(segments![1].output).toBe("\nline9\nline10\n")
  })

  it("splits grep; echo; cat into a search and a read", () => {
    const command =
      "/bin/zsh -lc 'grep -n multiply f; echo \"File contents:\"; cat -n f'"
    const output = "12:  docstring\nFile contents:\n     1\tdef product"
    const segments = splitChainedCommandWithOutputs(command, output)
    expect(segments).not.toBeNull()
    expect(segments!.map((s) => s.kind)).toEqual(["search", "read"])
    expect(segments![0].command).toBe("grep -n multiply f")
    expect(segments![1].command).toBe("cat -n f")
  })

  it("splits ls -la && cat into a list and a read", () => {
    // The engine classifies `ls && cat` as [listFiles, read] — a MIXED set.
    // No single card title fits, so the splitter renders one List + one Read.
    const command = "/bin/zsh -lc 'ls -la && cat calculator.py'"
    const output = "drwxr-xr-x  file\nline1\nline2\n"
    const segments = splitChainedCommandWithOutputs(command, output)
    expect(segments).not.toBeNull()
    expect(segments!.map((s) => s.kind)).toEqual(["list", "read"])
    expect(segments![0].command).toBe("ls -la")
    expect(segments![1].command).toBe("cat calculator.py")
  })

  it("returns null for a chain of only generic commands", () => {
    const segments = splitChainedCommandWithOutputs(
      "mkdir -p /tmp/x && cd /tmp/x && touch a.txt",
      null
    )
    expect(segments).toBeNull()
  })

  it("returns null for heredocs (would mangle)", () => {
    const segments = splitChainedCommandWithOutputs(
      "cat <<EOF\nhello\nEOF",
      null
    )
    expect(segments).toBeNull()
  })

  it("does not split on pipelines (head | grep stays whole)", () => {
    const segments = splitChainedCommandWithOutputs(
      "/bin/zsh -lc 'head -n 100 f | grep foo'",
      null
    )
    // Single token after unwrap → no chain.
    expect(segments).toBeNull()
  })

  it("keeps output on the last card when labels cannot be matched", () => {
    const command = "/bin/zsh -lc 'head -n 5 a && tail -n 5 b'"
    const output = "first lines\nsecond lines\n"
    const segments = splitChainedCommandWithOutputs(command, output)
    expect(segments).not.toBeNull()
    expect(segments![0].output).toBeNull()
    expect(segments![1].output).toBe("first lines\nsecond lines\n")
  })
})

describe("synthesizeSegmentInput", () => {
  it("synthesizes a read file_path", () => {
    expect(
      synthesizeSegmentInput({
        command: "head -n 20 calculator.py",
        kind: "read",
        output: null,
      })
    ).toBe(JSON.stringify({ file_path: "calculator.py" }))
  })

  it("synthesizes a grep pattern", () => {
    expect(
      synthesizeSegmentInput({
        command: 'grep -n "multiply" calculator.py',
        kind: "search",
        output: null,
      })
    ).toBe(JSON.stringify({ pattern: "multiply" }))
  })

  it("returns null for generic commands", () => {
    expect(
      synthesizeSegmentInput({
        command: "npm run build",
        kind: "command",
        output: null,
      })
    ).toBeNull()
  })
})

describe("segmentToolName", () => {
  it("maps kinds to canonical lane names", () => {
    expect(segmentToolName("read")).toBe("read")
    expect(segmentToolName("search")).toBe("grep")
    expect(segmentToolName("list")).toBe("list_files")
    expect(segmentToolName("command")).toBe("bash")
  })
})
