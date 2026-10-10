/**
 * shared/meta —— 类型定义的唯一来源。
 *
 * 纯类型 + 常量，无运行时副作用，三种宿主都能 import。
 * 与 `shared/core` 的分工：**这里只放"是什么"，core 放"怎么算"**。
 */
export * from './type';
export * from './interface';
