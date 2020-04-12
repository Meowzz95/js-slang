// @ts-ignore
import { Context, createContext, IOptions, runInContext } from './index'

const options: Partial<IOptions> = { scheduler: 'nondet', executionMethod: 'interpreter' }
const res = runInContext(
  // "const a=1;a+1;",
  // 'const a=1; const b=2; const c=true; c?a:b;',
  // 'function add(a,b){return a()+b();} function aV(){return 1+bV();} function bV(){return 2;} if(1!==null){add(aV,bV);} else{ 999; }',
  // 'function add(a,b){return a+b;} function aV(){return 1;} function bV(){return 2;} add(aV(),bV());',
  // 'function require(predicate) {return predicate ? "require success" : amb();} const a=amb(2,1,3,4); require(a>2); a;',

  'function require(predicate) {return predicate ? "require success" : amb();}\n' +
    'function distinct(xs) {\n' +
    '    return is_null(xs) || is_null(tail(xs))\n' +
    '        ? true\n' +
    '        : is_null(member(head(xs), tail(xs))) && \n' +
    '          distinct(tail(xs));\n' +
    '}\n' +
    '\n' +
    'function multiple_dwelling() {\n' +
    '    const baker = amb(1, 2, 3, 4, 5);\n' +
    '    const cooper = amb(1, 2, 3, 4, 5);\n' +
    '    const fletcher = amb(1, 2, 3, 4, 5);\n' +
    '    const miller = amb(1, 2, 3, 4, 5);\n' +
    '    const smith = amb(1, 2, 3, 4, 5);\n' +
    '    require(distinct(list(baker, cooper, fletcher, miller, smith)));\n' +
    '    require(! (baker === 5));\n' +
    '    require(! (cooper === 1));\n' +
    '    require(! (fletcher === 5));\n' +
    '    require(! (fletcher === 1));\n' +
    '    require(miller > cooper);\n' +
    '    require(! (math_abs(smith - fletcher) === 1));\n' +
    '    require(! (math_abs(fletcher - cooper) === 1));\n' +
    '    return list(list("baker", baker),\n' +
    '                list("cooper", cooper),\n' +
    '                list("fletcher", fletcher),\n' +
    '                list("miller", miller),\n' +
    '                list("smith", smith));\n' +
    '}\n' +
    '\n' +
    'multiple_dwelling();',
  // 'function check(li){display(head(li)); return tail(li);} check(list(1,3));',
  // 'function check(li){head(li); return tail(li);} check(list(1,2,3));',
  // 'const li = list(1,2,3); display(head(li)); li;',
  createContext(2),
  options
)
res.then(v => {
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
