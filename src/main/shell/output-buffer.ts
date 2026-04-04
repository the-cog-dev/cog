export class OutputBuffer {
  private lines: string[] = []
  private partial: string = ''

  constructor(private maxLines: number = 1000) {}

  push(line: string): void {
    this.lines.push(line)
    while (this.lines.length > this.maxLines) {
      this.lines.shift()
    }
  }

  pushRaw(data: string): void {
    // PTY data arrives as arbitrary chunks, not line-aligned.
    // Accumulate partial lines and only push complete ones.
    const text = this.partial + data
    const parts = text.split('\n')

    // Everything except the last part is a complete line
    for (let i = 0; i < parts.length - 1; i++) {
      this.push(parts[i])
    }

    // Last part is either empty (data ended with \n) or a partial line
    this.partial = parts[parts.length - 1]
  }

  get lineCount(): number {
    return this.lines.length
  }

  getLines(count: number): string[] {
    // Include the current partial line if non-empty
    if (this.partial) {
      const allLines = [...this.lines, this.partial]
      return allLines.slice(-count)
    }
    return this.lines.slice(-count)
  }
}
