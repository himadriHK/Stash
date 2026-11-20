using System;
using System.Reflection;

var asm = Assembly.LoadFrom(@"C:\Users\himad\.nuget\packages\microsoft.javascript.nodeapi\0.9.27\lib\net10.0\Microsoft.JavaScript.NodeApi.dll");
foreach (var t in asm.GetTypes())
{
    Console.WriteLine($"{t.Namespace}.{t.Name}");
}
