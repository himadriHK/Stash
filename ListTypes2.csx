using System;
using System.Reflection;
using System.Linq;

var asm = Assembly.LoadFrom(@"C:\Users\himad\.nuget\packages\microsoft.javascript.nodeapi\0.9.27\lib\net10.0\Microsoft.JavaScript.NodeApi.dll");

// Look at JSRuntimeContext
var rtCtx = asm.GetType("Microsoft.JavaScript.NodeApi.Interop.JSRuntimeContext");
if (rtCtx != null)
{
    Console.WriteLine("=== JSRuntimeContext ===");
    foreach (var ctor in rtCtx.GetConstructors())
    {
        Console.WriteLine($"  ctor({string.Join(", ", ctor.GetParameters().Select(p => p.ParameterType.Name))})");
    }
    foreach (var m in rtCtx.GetMethods().Where(m => !m.IsSpecialName).Take(15))
    {
        Console.WriteLine($"  method: {m.Name}({string.Join(", ", m.GetParameters().Select(p => p.ParameterType.Name))})");
    }
    foreach (var p in rtCtx.GetProperties())
    {
        Console.WriteLine($"  prop: {p.Name} ({p.PropertyType.Name})");
    }
}

Console.WriteLine();

// Look at JSValue
var jsValue = asm.GetType("Microsoft.JavaScript.NodeApi.Interop.JSValue");
if (jsValue != null)
{
    Console.WriteLine("=== JSValue ===");
    foreach (var m in jsValue.GetMethods().Where(m => !m.IsSpecialName).Take(20))
    {
        Console.WriteLine($"  method: {m.Name}({string.Join(", ", m.GetParameters().Select(p => p.ParameterType.Name))})");
    }
    foreach (var p in jsValue.GetProperties().Take(15))
    {
        Console.WriteLine($"  prop: {p.Name} ({p.PropertyType.Name})");
    }
}

Console.WriteLine();

// Look at JSModuleContext
var jsModuleCtx = asm.GetType("Microsoft.JavaScript.NodeApi.Interop.JSModuleContext");
if (jsModuleCtx != null)
{
    Console.WriteLine("=== JSModuleContext ===");
    foreach (var ctor in jsModuleCtx.GetConstructors())
    {
        Console.WriteLine($"  ctor({string.Join(", ", ctor.GetParameters().Select(p => p.ParameterType.Name))})");
    }
    foreach (var m in jsModuleCtx.GetMethods().Where(m => !m.IsSpecialName).Take(15))
    {
        Console.WriteLine($"  method: {m.Name}({string.Join(", ", m.GetParameters().Select(p => p.ParameterType.Name))})");
    }
    foreach (var p in jsModuleCtx.GetProperties().Take(15))
    {
        Console.WriteLine($"  prop: {p.Name} ({p.PropertyType.Name})");
    }
}

Console.WriteLine();

// Look at JSModuleBuilder
var jsModuleBuilder = asm.GetType("Microsoft.JavaScript.NodeApi.Interop.JSModuleBuilder");
if (jsModuleBuilder != null)
{
    Console.WriteLine("=== JSModuleBuilder ===");
    foreach (var ctor in jsModuleBuilder.GetConstructors())
    {
        Console.WriteLine($"  ctor({string.Join(", ", ctor.GetParameters().Select(p => p.ParameterType.Name))})");
    }
    foreach (var m in jsModuleBuilder.GetMethods().Where(m => !m.IsSpecialName).Take(15))
    {
        Console.WriteLine($"  method: {m.Name}({string.Join(", ", m.GetParameters().Select(p => p.ParameterType.Name))})");
    }
}
