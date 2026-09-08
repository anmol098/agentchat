/**
 * Nominal ("branded") types.
 *
 * TypeScript is structurally typed, so `type AgentId = string` and
 * `type ProjectId = string` are the same type and the compiler happily accepts
 * one where the other is required. Every identifier in AgentChat is a string of
 * the same shape, so that mistake is not hypothetical: passing a project id as
 * the sender agent would type-check and fail at the database.
 *
 * Intersecting with a property keyed by a module-private `unique symbol` makes
 * the types nominal. The symbol is never exported, so no code outside this file
 * can construct a branded value structurally; the only way in is through the
 * constructors in `./ids.js`, which validate first.
 *
 * @module
 */

/**
 * Module-private brand carrier.
 *
 * Declared, never defined: it exists only in the type system and no value with
 * this key is ever created at runtime. A branded value is an ordinary string.
 */
declare const brand: unique symbol;

/**
 * Attaches a compile-time-only tag to `T`, making it nominally typed.
 *
 * The result is assignable *to* `T` (a `MessageId` is usable wherever a
 * `string` is), but `T` is not assignable *to* the brand, and two brands with
 * different tags are mutually unassignable. Nothing about the runtime
 * representation changes.
 *
 * @typeParam T - The underlying representation, in this package always `string`.
 * @typeParam TTag - A unique tag; by convention the name of the branded type.
 *
 * @example
 * ```ts
 * type OrderId = Brand<string, "OrderId">;
 * const id = "abc" as OrderId;   // deliberate widening at the boundary
 * const raw: string = id;        // fine: brands are still strings
 * ```
 */
export type Brand<T, TTag extends string> = T & { readonly [brand]: TTag };
