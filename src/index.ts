import { simple } from 'acorn-walk/dist/walk'
import { DebuggerStatement, Literal, Program, SourceLocation } from 'estree'
import { RawSourceMap, SourceMapConsumer } from 'source-map'
import { JSSLANG_PROPERTIES, UNKNOWN_LOCATION } from './constants'
import createContext from './createContext'
import {
  ConstAssignment,
  ExceptionError,
  InterruptedError,
  UndefinedVariable
} from './errors/errors'
import { RuntimeSourceError } from './errors/runtimeSourceError'
import { findDeclarationNode, findIdentifierNode } from './finder'
import { evaluate } from './interpreter/interpreter'
import { parse, parseAt, parseForNames } from './parser/parser'
import { AsyncScheduler, PreemptiveScheduler, NonDetScheduler } from './schedulers'
import { getAllOccurrencesInScopeHelper, getScopeHelper } from './scope-refactoring'
import { areBreakpointsSet, setBreakpointAtLine } from './stdlib/inspector'
import { getEvaluationSteps } from './stepper/stepper'
import { sandboxedEval } from './transpiler/evalContainer'
import { transpile } from './transpiler/transpiler'
import {
  Context,
  Error as ResultError,
  ExecutionMethod,
  Finished,
  Result,
  Scheduler,
  SourceError,
  Variant
} from './types'
import { nonDetEvaluate } from './interpreter/interpreter-non-det'
import { locationDummyNode } from './utils/astCreator'
import { validateAndAnnotate } from './validator/validator'
import { compileWithPrelude } from './vm/svml-compiler'
import { runWithProgram } from './vm/svml-machine'
export { SourceDocumentation } from './editors/ace/docTooltip'
import { getProgramNames } from './name-extractor'

export interface IOptions {
  scheduler: 'preemptive' | 'async'
  steps: number
  executionMethod: ExecutionMethod
  variant: Variant
  originalMaxExecTime: number
  useSubst: boolean
}

const DEFAULT_OPTIONS: IOptions = {
  scheduler: 'async',
  steps: 1000,
  executionMethod: 'auto',
  variant: 'default',
  originalMaxExecTime: 1000,
  useSubst: false
}

// needed to work on browsers
if (typeof window !== 'undefined') {
  // @ts-ignore
  SourceMapConsumer.initialize({
    'lib/mappings.wasm': 'https://unpkg.com/source-map@0.7.3/lib/mappings.wasm'
  })
}

// deals with parsing error objects and converting them to strings (for repl at least)

let verboseErrors = false
const resolvedErrorPromise = Promise.resolve({ status: 'error' } as Result)

export function parseError(errors: SourceError[], verbose: boolean = verboseErrors): string {
  const errorMessagesArr = errors.map(error => {
    const line = error.location ? error.location.start.line : '<unknown>'
    const column = error.location ? error.location.start.column : '<unknown>'
    const explanation = error.explain()

    if (verbose) {
      // TODO currently elaboration is just tagged on to a new line after the error message itself. find a better
      // way to display it.
      const elaboration = error.elaborate()
      return `Line ${line}, Column ${column}: ${explanation}\n${elaboration}\n`
    } else {
      return `Line ${line}: ${explanation}`
    }
  })
  return errorMessagesArr.join('\n')
}

function convertNativeErrorToSourceError(
  error: Error,
  line: number | null,
  column: number | null,
  name: string | null
) {
  // brute-forced from MDN website for phrasing of errors from different browsers
  // FWIW node and chrome uses V8 so they'll have the same error messages
  // unable to test on other engines
  const assignmentToConst = [
    'invalid assignment to const',
    'Assignment to constant variable',
    'Assignment to const',
    'Redeclaration of const'
  ]
  const undefinedVariable = ['is not defined']

  const message = error.message
  if (name === null) {
    name = 'UNKNOWN'
  }

  function messageContains(possibleErrorMessages: string[]) {
    return possibleErrorMessages.some(errorMessage => message.includes(errorMessage))
  }

  if (messageContains(assignmentToConst)) {
    return new ConstAssignment(locationDummyNode(line!, column!), name)
  } else if (messageContains(undefinedVariable)) {
    return new UndefinedVariable(name, locationDummyNode(line!, column!))
  } else {
    const location =
      line === null || column === null
        ? UNKNOWN_LOCATION
        : {
            start: { line, column },
            end: { line: -1, column: -1 }
          }
    return new ExceptionError(error, location)
  }
}

let previousCode = ''

function determineExecutionMethod(theOptions: IOptions, context: Context, program: Program) {
  let isNativeRunnable
  if (theOptions.executionMethod === 'auto') {
    if (context.executionMethod === 'auto') {
      if (verboseErrors) {
        isNativeRunnable = false
      } else if (areBreakpointsSet()) {
        isNativeRunnable = false
      } else {
        let hasDeuggerStatement = false
        simple(program, {
          DebuggerStatement(node: DebuggerStatement) {
            hasDeuggerStatement = true
          }
        })
        isNativeRunnable = !hasDeuggerStatement
      }
      context.executionMethod = isNativeRunnable ? 'native' : 'interpreter'
    } else {
      isNativeRunnable = context.executionMethod === 'native'
    }
  } else {
    isNativeRunnable = theOptions.executionMethod === 'native'
    context.executionMethod = theOptions.executionMethod
  }
  return isNativeRunnable
}

export function findDeclaration(
  code: string,
  context: Context,
  loc: { line: number; column: number }
): SourceLocation | null | undefined {
  const program = parse(code, context, true)
  if (!program) {
    return null
  }
  const identifierNode = findIdentifierNode(program, context, loc)
  if (!identifierNode) {
    return null
  }
  const declarationNode = findDeclarationNode(program, identifierNode)
  if (!declarationNode || identifierNode === declarationNode) {
    return null
  }
  return declarationNode.loc
}

export function getScope(
  code: string,
  context: Context,
  loc: { line: number; column: number }
): SourceLocation[] {
  const program = parse(code, context, true)
  if (!program) {
    return []
  }
  const identifierNode = findIdentifierNode(program, context, loc)
  if (!identifierNode) {
    return []
  }
  const declarationNode = findDeclarationNode(program, identifierNode)
  if (!declarationNode || declarationNode.loc == null || identifierNode !== declarationNode) {
    return []
  }

  return getScopeHelper(declarationNode.loc, program, identifierNode.name)
}

export function getAllOccurrencesInScope(
  code: string,
  context: Context,
  loc: { line: number; column: number }
): SourceLocation[] {
  const program = parse(code, context, true)
  if (!program) {
    return []
  }
  const identifierNode = findIdentifierNode(program, context, loc)
  if (!identifierNode) {
    return []
  }
  const declarationNode = findDeclarationNode(program, identifierNode)
  if (declarationNode == null || declarationNode.loc == null) {
    return []
  }
  return getAllOccurrencesInScopeHelper(declarationNode.loc, program, identifierNode.name)
}

export async function getNames(code: string, line: number, col: number): Promise<any> {
  const [program, comments] = parseForNames(code)

  if (!program) {
    return []
  }
  return getProgramNames(program, comments, { line, column: col })
}

export async function runInContext(
  code: string,
  context: Context,
  options: Partial<IOptions> = {}
): Promise<Result> {
  function getFirstLine(theCode: string) {
    const theProgramFirstExpression = parseAt(theCode, 0)

    if (theProgramFirstExpression && theProgramFirstExpression.type === 'Literal') {
      return ((theProgramFirstExpression as unknown) as Literal).value
    }

    return undefined
  }
  const theOptions: IOptions = { ...DEFAULT_OPTIONS, ...options }
  context.variant = determineVariant(context, options)
  context.errors = []

  verboseErrors = getFirstLine(code) === 'enable verbose'
  const program = parse(code, context)
  if (!program) {
    return resolvedErrorPromise
  }
  validateAndAnnotate(program as Program, context)
  if (context.errors.length > 0) {
    return resolvedErrorPromise
  }
  if (context.variant === 'concurrent') {
    if (previousCode === code) {
      JSSLANG_PROPERTIES.maxExecTime *= JSSLANG_PROPERTIES.factorToIncreaseBy
    } else {
      JSSLANG_PROPERTIES.maxExecTime = theOptions.originalMaxExecTime
    }
    previousCode = code
    try {
      return Promise.resolve({
        status: 'finished',
        value: runWithProgram(compileWithPrelude(program, context), context)
      } as Result)
    } catch (error) {
      if (error instanceof RuntimeSourceError || error instanceof ExceptionError) {
        context.errors.push(error) // use ExceptionErrors for non Source Errors
        return resolvedErrorPromise
      }
      context.errors.push(new ExceptionError(error, UNKNOWN_LOCATION))
      return resolvedErrorPromise
    }
  }
  if (options.useSubst) {
    const steps = getEvaluationSteps(program, context)
    return Promise.resolve({
      status: 'finished',
      value: steps
    } as Result)
  }
  const isNativeRunnable = determineExecutionMethod(theOptions, context, program)
  if (context.prelude !== null) {
    const prelude = context.prelude
    context.prelude = null
    await runInContext(prelude, context, options)
    return runInContext(code, context, options)
  }
  if (isNativeRunnable) {
    if (previousCode === code) {
      JSSLANG_PROPERTIES.maxExecTime *= JSSLANG_PROPERTIES.factorToIncreaseBy
    } else {
      JSSLANG_PROPERTIES.maxExecTime = theOptions.originalMaxExecTime
    }
    previousCode = code
    let transpiled
    let sourceMapJson: RawSourceMap | undefined
    let lastStatementSourceMapJson: RawSourceMap | undefined
    try {
      const temp = transpile(program, context.contextId, false, context.variant)
      // some issues with formatting and semicolons and tslint so no destructure
      transpiled = temp.transpiled
      sourceMapJson = temp.codeMap
      lastStatementSourceMapJson = temp.evalMap
      return Promise.resolve({
        status: 'finished',
        value: sandboxedEval(transpiled)
      } as Result)
    } catch (error) {
      if (error instanceof RuntimeSourceError) {
        context.errors.push(error)
        return resolvedErrorPromise
      }
      if (error instanceof ExceptionError) {
        // if we know the location of the error, just throw it
        if (error.location.start.line !== -1) {
          context.errors.push(error)
          return resolvedErrorPromise
        } else {
          error = error.error // else we try to get the location from source map
        }
      }
      const errorStack = error.stack
      const match = /<anonymous>:(\d+):(\d+)/.exec(errorStack)
      if (match === null) {
        context.errors.push(new ExceptionError(error, UNKNOWN_LOCATION))
        return resolvedErrorPromise
      }
      const line = Number(match![1])
      const column = Number(match![2])
      return SourceMapConsumer.with(
        line === 1 ? lastStatementSourceMapJson! : sourceMapJson!,
        null,
        consumer => {
          const { line: originalLine, column: originalColumn, name } = consumer.originalPositionFor(
            {
              line,
              column
            }
          )
          context.errors.push(
            convertNativeErrorToSourceError(error, originalLine, originalColumn, name)
          )
          return resolvedErrorPromise
        }
      )
    }
  } else {
    let it = evaluate(program, context)
    let scheduler: Scheduler
    if (context.variant === 'non-det') {
      it = nonDetEvaluate(program, context)
      scheduler = new NonDetScheduler()
    } else if (theOptions.scheduler === 'async') {
      scheduler = new AsyncScheduler()
    } else {
      scheduler = new PreemptiveScheduler(theOptions.steps)
    }
    return scheduler.run(it, context)
  }
}

/**
 * Small function to determine the variant to be used
 * by a program, as both context and options can have
 * a variant. The variant provided in options will
 * have precedence over the variant provided in context.
 *
 * @param context The context of the program.
 * @param options Options to be used when
 *                running the program.
 *
 * @returns The variant that the program is to be run in
 */
function determineVariant(context: Context, options: Partial<IOptions>): Variant {
  if (options.variant) {
    return options.variant
  } else {
    return context.variant
  }
}

export function resume(result: Result): Finished | ResultError | Promise<Result> {
  if (result.status === 'finished' || result.status === 'error') {
    return result
  } else {
    return result.scheduler.run(result.it, result.context)
  }
}

export function interrupt(context: Context) {
  const globalEnvironment = context.runtime.environments[context.runtime.environments.length - 1]
  context.runtime.environments = [globalEnvironment]
  context.runtime.isRunning = false
  context.errors.push(new InterruptedError(context.runtime.nodes[0]))
}

export { createContext, Context, Result, setBreakpointAtLine }
