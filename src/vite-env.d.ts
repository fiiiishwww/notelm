/// <reference types="vite/client" />

/**
 * 让 TypeScript 认识 import.meta.env（Vite 注入的环境变量）。
 *
 * tsconfig 里 types 只列了 "node"，Vite 的客户端类型不会被自动带上，
 * 所以必须在这里显式 reference 一次。不引它的话，代码里任何一处
 * import.meta.env.DEV 都会让 tsc --noEmit（也就是 npm run build 的第一步）报错。
 */
