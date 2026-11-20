using System;
using System.Reflection;

var asm = Assembly.LoadFrom(@"C:\Users\himad\.nuget\packages\microsoft.javascript.nodeapi\0.9.27\lib\net10.0\Microsoft.JavaScript.NodeApi.dll");
Console.WriteLine($"Assembly: {asm.FullName}");
foreach (var t in asm.GetTypes().OrderBy(t => t.Namespace).ThenBy(t => t.Name))
{
    Console.WriteLine($"{t.Namespace}.{t.Name}");
}
