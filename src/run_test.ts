// @ts-ignore
import { Context, createContext, IOptions, runInContext } from './index'

const options: Partial<IOptions> = { scheduler: 'nondet', executionMethod: 'interpreter' }
let res = runInContext(
  // "const a=1;a+1;",
  "const a=1; const b=2; const c=true; c?a:b;",
  createContext(),
  options
)
res.then(v=>{
  console.log(v)
})

// function* gen() {
//   console.log("1")
//   yield "haha"
//   console.log("2")
// }
//
// function* gengen(){
//   yield* gen()
// }

// const generator = gengen()
// let n = generator.next()
// console.log(n.value)
// n = generator.next()
// console.log(n.value)

// function* ry(){
//   console.log("3")
//   return yield* gen()
//   console.log("4")
// }
//
// const ryGen = ry()
//
// let n = ryGen.next()
// console.log(n.value)
// n = ryGen.next()
// console.log(n.value)
