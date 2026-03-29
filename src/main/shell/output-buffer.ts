export class OutputBuffer {
  private lines: string[] = []

  constructor(private maxLines: number = 1000) {}

  push(line: string): void {
    this.lines.push(line)
    while (this.lines.length > this.maxLines) {
      this.lines.shift()
    }
  }

  pushRaw(data: string): void {
    const newLines = data.split('\n')
    for (const line of newLines) {
      this.push(line)
    }
  }

  getLines(count: number): string[] {
    return this.lines.slice(-count)
  }
}
