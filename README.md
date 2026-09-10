# NOVA

A modern, type-safe, AI-native programming language.

NOVA is a statically-typed language with pattern matching, algebraic data types, and automatic error propagation. It compiles to JavaScript for instant startup and can be interpreted directly for development.

## Features

- **Static type inference** with explicit annotations available
- **Algebraic data types**: structs, enums, and result types (`ok(T)` / `err(E)`)
- **Pattern matching** with `match` expressions
- **Automatic error propagation** with the `?` operator
- **First-class functions** and closures
- **Modules** with `use` declarations
- **Zero-dependency runtime** — compiles to standalone JS

## Quick Start

```bash
# Run a program
nova run hello.nova

# Type-check only
nova check hello.nova

# Compile to standalone JS
nova build hello.nova

# Format a file
nova fmt hello.nova

# Start REPL
nova repl

# Create a new project
nova new my-project
cd my-project
nova run src/main.nova
```

## Language Basics

### Variables and Types

```nova
x: Int = 42
name: String = "NOVA"
items = [1, 2, 3]       // type inferred
```

### Functions

```nova
fn add(a: Int, b: Int) -> Int {
    a + b  // implicit return
}

fn greet(name: String) -> String {
    "Hello, {name}!"
}
```

### Structs

```nova
struct User {
    id: Int
    name: String
    email: String
}

fn main() {
    user = User(id: 1, name: "Alice", email: "alice@nova.dev")
    print(user.name)
}
```

### Enums

```nova
enum Shape {
    Circle(radius: Float)
    Rectangle(width: Float, height: Float)
    Square(side: Float)
}

fn area(shape: Shape) -> Float {
    match shape {
        Shape.Circle(r) => 3.14159 * r * r
        Shape.Rectangle(w, h) => w * h
        Shape.Square(s) => s * s
    }
}
```

### Error Handling with Result Types

```nova
fn parse_int(s: String) -> Result<Int, String> {
    if s.matches(/^\d+$/) {
        ok(s.to_int())
    } else {
        err("not a number: {s}")
    }
}

fn main() {
    result = parse_int("42")
    value = result?  // propagates error if err
    print(value)
}
```

### Arrays and Maps

```nova
fn main() {
    nums = [1, 2, 3, 4, 5]
    doubled = nums.map(|n| n * 2)
    
    scores = {"alice": 100, "bob": 85}
    print(scores["alice"])
    
    for key, value in scores {
        print("{key}: {value}")
    }
}
```

### Closures

```nova
fn main() {
    add = |a, b| a + b
    print(add(3, 4))  // 7
    
    multiplier = |factor| |x| x * factor
    triple = multiplier(3)
    print(triple(5))  // 15
}
```

### Modules

```nova
// math.nova
fn add(a: Int, b: Int) -> Int { a + b }
fn sub(a: Int, b: Int) -> Int { a - b }

// main.nova
use "math.nova"

fn main() {
    print(add(1, 2))
}
```

### Testing

```nova
fn add(a: Int, b: Int) -> Int { a + b }

test "add works" {
    expect(add(1, 2) == 3)
    expect(add(-1, 1) == 0)
}

test "add with zero" {
    expect(add(0, 5) == 5)
}
```

## Built-in Functions

### Output & Conversion

| Function | Description |
|----------|-------------|
| `print(...)` | Print values to stdout |
| `println(...)` | Print with newline |
| `str(v)` | Convert to string |
| `int(v)` | Convert to integer |
| `float(v)` | Convert to float |
| `typeof(v)` | Get type name as string |

### Math

| Function | Description |
|----------|-------------|
| `abs(n)` | Absolute value |
| `min(...)` | Minimum value |
| `max(...)` | Maximum value |
| `floor(n)` | Floor |
| `ceil(n)` | Ceiling |
| `round(n)` | Round |
| `sqrt(n)` | Square root |
| `pow(b, e)` | Power |
| `random()` | Random float [0, 1) |
| `random_int(lo, hi)` | Random integer in [lo, hi] |

### Arrays

| Function | Description |
|----------|-------------|
| `len(v)` | Length of string/array/map |
| `range(n)` | Array [0, 1, ..., n-1] |
| `push(a, v)` | Append to array |
| `pop(a)` | Remove and return last element |
| `first(a)` | First element |
| `last(a)` | Last element |
| `slice(v, start, end)` | Substring or subarray |
| `contains(v, item)` | Check if contains |
| `join(a, sep)` | Join array with separator |
| `reverse(a)` | Reverse array |
| `sort(a)` | Sort array |

### Maps

| Function | Description |
|----------|-------------|
| `keys(m)` | Map keys as array |
| `values(m)` | Map values as array |
| `has(m, k)` | Check map has key |
| `remove(m, k)` | Remove map entry |
| `merge(m1, m2)` | Merge two maps |

### Testing & IO

| Function | Description |
|----------|-------------|
| `expect(v)` | Assert truthy |
| `expect_eq(a, b)` | Assert equality |
| `clock_ms()` | Current time in milliseconds |
| `input(prompt?)` | Read user input |

## Standard Library

> **Note**: The standard library below (string/array/map methods, `math` module, `file` module) is planned but not yet implemented. Currently, the built-in functions above are available.

### Strings (planned)

### Strings

```nova
s = "hello"
s.length      // 5
s.upper()     // "HELLO"
s.lower()     // "hello"
s.trim()      // trim whitespace
s.split(",")  // split by delimiter
s.contains("ell")  // true
s.starts_with("he")  // true
s.ends_with("lo")  // true
s.replace("l", "r")  // "herro"
s.slice(1, 3)  // "el"
s.to_int()    // parse as int
s.to_float()  // parse as float
```

### Arrays

```nova
arr = [1, 2, 3]
arr.length
arr.push(4)
arr.pop()
arr.first()
arr.last()
arr.slice(1, 3)
arr.map(|x| x * 2)
arr.filter(|x| x > 1)
arr.reduce(0, |acc, x| acc + x)
arr.includes(2)
arr.join(", ")
arr.reverse()
arr.sort()
```

### Maps

```nova
m = {"a": 1, "b": 2}
m.keys()
m.values()
m.has("a")
m.remove("a")
m.merge({"c": 3})
```

### Math

```nova
math.pi
math.e
math.abs(-5)
math.floor(3.7)
math.ceil(3.2)
math.round(3.5)
math.pow(2, 10)
math.sqrt(16)
math.min(3, 5)
math.max(3, 5)
math.random()
math.random_int(1, 100)
```

### IO

```nova
print("hello")
println("hello")
input("Enter name: ")
file.read("data.txt")
file.write("data.txt", "content")
file.exists("data.txt")
file.delete("data.txt")
```

## Implementation

NOVA is implemented in TypeScript and runs on Node.js.

```
src/
  cli/           # CLI (nova run/build/check/fmt/...)
  compiler/
    lexer/       # Tokenizer
    parser/      # Parser (recursive descent)
    ast/         # AST definitions
    typechecker/ # Type checker and inference
    codegen/     # JavaScript code generation
    diagnostics/ # Error reporting
  fmt/           # Code formatter
  runtime/       # Tree-walking interpreter
```

## License

MIT