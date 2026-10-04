#!/usr/bin/env node
import { runCli } from './run.js'

runCli(process.argv.slice(2), process.env).then((code) => {
  process.exitCode = code
})
