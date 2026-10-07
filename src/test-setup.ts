/**
 * Ajustes compartidos por los tests que corren en un DOM (happy-dom).
 *
 * Va como `setupFiles` en vez de repetirse en cada fichero porque son tres cosas
 * que hay que hacer siempre y olvidar una rompe el test de forma confusa.
 */

import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vite-plus/test";

// RTL monta en `document.body` y no desmonta solo: sin esto cada test acumula
// el DOM del anterior y `getByText` encuentra nodos de otra prueba.
afterEach(() => cleanup());

// happy-dom no implementa layout, así que `scrollIntoView` no existe. Varias
// librerías lo llaman en mount; fallaría con "is not a function".
if (typeof Element !== "undefined" && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}
