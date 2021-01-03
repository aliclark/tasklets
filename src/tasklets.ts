
interface Work {
    cancel: () => unknown
}

interface Job<Result> {
    (done: (result: Result | Error) => void, reject: (error: Error) => void): Work | unknown
}

type Contract<Result> = Job<Result> | PromiseLike<Result>

interface Options {
    timeout: number
}

enum Outcome {
    Uninitialized,
    Pending,
    Error,
    Result
}

export interface Tasklet<Result> extends Promise<Result> {
    errors(rejected: (error: Error) => unknown): Tasklet<Result>
    results(fulfilled: (result: Result) => unknown): Tasklet<Result>

    or(rejected: (error: Error) => Contract<Result>, options?: Options): Tasklet<Result>
    and<New>(fulfilled: (result: Result) => Contract<New>, options?: Options): Tasklet<New>
}

class TimeoutError extends Error {}

class WorkError extends Error {
    constructor(public readonly problem: Error) {
        super(`Problem while contracting work: ${problem}`)
    }
}

class CancellationError extends Error {
    constructor(public readonly problem: Error) {
        super(`Problem while cancelling work: ${problem}`)
    }
}

class RejectionError extends Error {
    constructor(public readonly error: Error, public readonly problem: Error) {
        super(`Problem while calling rejection handler for error: ${error}, problem: ${problem}`)
    }
}

class FulfillmentError<Result> extends Error {
    constructor(public readonly result: Result, public readonly problem: Error) {
        super(`Problem while calling fulfillment handler for result: ${result}, problem: ${problem}`)
    }
}

function isPromiseLikeShape<T>(obj: any): obj is PromiseLike<T> {
    return obj !== undefined && obj !== null && typeof obj.then === 'function' 
}

function isWorkShape(obj: any): obj is Work {
    return obj !== undefined && obj !== null && typeof obj.cancel === 'function'
}

export class Tasklet<Result> implements Tasklet<Result> {

    private options: Options

    constructor(
        options?: Options,
        private defaultTimeout: number = 8,
        private defaultOptions: Options = { timeout: defaultTimeout },
        private resolvedErrors: Error[] = [],
        private resolvedResults: Result[] = [],
        private errorHandlers: ((error: Error) => unknown)[] = [],
        private resultHandlers: ((result: Result) => unknown)[] = [],
        private outcome: Outcome = Outcome.Uninitialized) {

        if (options === undefined || options === null) {
            this.options = this.defaultOptions
        } else {
            this.options = options
        }
    }

    contracted(contract: Contract<Result>): Tasklet<Result> {

        if (this.outcome !== Outcome.Uninitialized) {
            throw new Error('This tasklet already has a contract defined')
        }
        this.outcome = Outcome.Pending

        const rejected = (error: Error) => {
            if (timer !== undefined) { clearTimeout(timer) }
            this.rejected(error)
        }

        const fulfilled = (result: Result) => {
            if (timer !== undefined) { clearTimeout(timer) }
            this.fulfilled(result)
        }

        let work: unknown = null
        const timer = this.options.timeout === 0 ? undefined : setTimeout(() => {
            if (isWorkShape(work)) {
                try {
                    work.cancel()
                } catch (problem) {
                    console.error(new CancellationError(problem))
                }
            }
            rejected(new TimeoutError())
        },
        this.options.timeout * 1000)

        if (typeof contract === 'function') {
            try {
                work = contract(outcome => outcome instanceof Error ? rejected(outcome) : fulfilled(outcome), rejected)
            } catch (problem) {
                rejected(new WorkError(problem))
            }
        } else {
            contract.then(fulfilled, rejected)
        }

        return this
    }

    private static handleRejection(rejected: (error: Error) => unknown, error: Error): void {
        try {
            rejected(error)
        } catch (problem) {
            console.error(new RejectionError(error, problem))
        }
    }

    private static handleFulfillment<Result>(fulfillment: (result: Result) => unknown, result: Result): void {
        try {
            fulfillment(result)
        } catch (problem) {
            console.error(new FulfillmentError(result, problem))
        }
    }

    private rejected(error: Error): Tasklet<Result> {
        if (this.outcome !== Outcome.Result) {
            this.outcome = Outcome.Error
        }
        this.resolvedErrors.push(error)

        process.nextTick(() => {
            if (this.errorHandlers.length > 0) {
                this.errorHandlers.forEach(rejected => Tasklet.handleRejection(rejected, error));
            } else {
                console.warn(error)
            }
        })
        return this
    }

    private fulfilled(result: Result, isPromise = false): Tasklet<Result> {
        if (this.outcome !== Outcome.Error) {
            this.outcome = Outcome.Result
        }
        this.resolvedResults.push(result)

        process.nextTick(() => {
            if (this.resultHandlers.length > 0) {
                this.resultHandlers.forEach(fulfillment => Tasklet.handleFulfillment(fulfillment, result))
            } else if (!isPromise) {
                // At the end of the tasklet chain is expected to be an 'await'
                // on the 'then' of the last tasklet.
                // In that case we don't expect a handler, so trace unhandled results
                console.trace(result)
            }
        })
        return this
    }

    errors(rejected: (error: Error) => unknown): Tasklet<Result> {
        this.errorHandlers.push(rejected)
        this.resolvedErrors.forEach(error => Tasklet.handleRejection(rejected, error))
        return this
    }

    results(fulfillment: (result: Result) => unknown): Tasklet<Result> {
        this.resultHandlers.push(fulfillment)
        this.resolvedResults.forEach(result => Tasklet.handleFulfillment(fulfillment, result))
        return this
    }

    or(rejected: (error: Error) => Contract<Result>, options?: Options): Tasklet<Result> {

        const tasklet = new Tasklet<Result>(options)

        let resolved = false
        const guard = (type: Outcome) => {
            if (type !== this.outcome) return true
            const previous = resolved
            resolved = true
            return previous
        }

        this.errors(error => {
            if (guard(Outcome.Error)) return

            try {
                tasklet.contracted(rejected(error))
            } catch (problem) {
                tasklet.rejected(new RejectionError(error, problem))
            }
        })

        this.results(result => {
            if (guard(Outcome.Result)) return
            tasklet.fulfilled(result)
        })

        return tasklet
    }

    and<New>(fulfilled: (result: Result) => Contract<New>, options?: Options): Tasklet<New> {

        const tasklet = new Tasklet<New>(options)

        let resolved = false
        const guard = (type: Outcome) => {
            if (type !== this.outcome) return true
            const previous = resolved
            resolved = true
            return previous
        }

        this.errors(error => {
            if (guard(Outcome.Error)) return
            tasklet.rejected(error)
        })

        this.results(result => {
            if (guard(Outcome.Result)) return

            try {
                tasklet.contracted(fulfilled(result))
            } catch (problem) {
                tasklet.rejected(new FulfillmentError(result, problem))
            }
        })

        return tasklet
    }

    [Symbol.toStringTag]: string = 'TaskletImpl<Result>'

    then<TResult1 = Result, TResult2 = never>(onfulfilled?: (Result: Result) => TResult1 | PromiseLike<TResult1>, onrejected?: (reason: any) => TResult2 | PromiseLike<TResult2>): Promise<TResult1 | TResult2> {

        if (onfulfilled === undefined) {
            // It's not possible to go from 'Result' type to 'TResult1' without an onfulfilled callback
            throw new Error("An onfulfilled handler must be supplied.")
        }

        // Retain the Promise semantics of having timeout on the contract fulfillment
        const tasklet = new Tasklet<TResult1 | TResult2>({ timeout: 0 })

        let resolved = false
        const guard = (type: Outcome) => {
            if (type !== this.outcome) return true
            const previous = resolved
            resolved = true
            return previous
        }

        this.errors(error => {
            if (guard(Outcome.Error)) return

            if (onrejected === undefined) {
                tasklet.rejected(error)
            } else {
                try {
                    const out = onrejected(error)

                    if (isPromiseLikeShape(out)) {
                        tasklet.contracted(out)
                    } else {
                        tasklet.fulfilled(out)
                    }
                } catch (problem) {
                    tasklet.rejected(new RejectionError(error, problem))
                }
            }
        })

        this.results(result => {
            if (guard(Outcome.Result)) return

            try {
                const out = onfulfilled(result)

                if (isPromiseLikeShape(out)) {
                    tasklet.contracted(out)
                } else {
                    tasklet.fulfilled(out, true)
                }
            } catch (problem) {
                tasklet.rejected(new FulfillmentError(result, problem))
            }
        })

        return tasklet
    }

    catch<TResult = never>(onrejected?: (reason: any) => TResult | PromiseLike<TResult>): Promise<Result | TResult> {
        return this.then(undefined, onrejected)
    }
}

export function make<Result>(contract: Contract<Result>, options?: Options): Tasklet<Result> {
    return new Tasklet<Result>(options).contracted(contract)
}

export function gather<Result>(tasklets: { [K in keyof Result]: Tasklet<Result[K]> }, options?: Options): Tasklet<{ [K in keyof Result]: Result[K] }> {

    if (options === undefined || options === null) {
        // Defer to the timeouts of the underlying tasklets by default
        options = { timeout: 0 }
    }

    return new Tasklet<Result>(options).contracted((done, rejected) => {

        const result: Partial<Result> = {}
        let size = 0
        let resolutions = 0

        for (const key in tasklets) {

            tasklets[key].or(error => (otherwise, rejectedListener) => {
                rejected(error)
                rejectedListener(error)
            }).errors(() => null)

            tasklets[key].and(value => then => {
                result[key] = value
                resolutions += 1
                if (resolutions === size) {
                    done(result as Result)
                }
                then(value)
            }).results(() => null)

            size += 1
        }
    })
}
