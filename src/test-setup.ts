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

// Tampoco hay layout, así que todo elemento mide 0. `useVirtualizer` de
// `Words` mide su contenedor para decidir cuántas filas pintar, y con 0 pinta
// ninguna: la tabla entera desaparecería del DOM en el test sin que nadie lo
// note. Se le da un alto plausible para que virtualice de verdad.
//
// El disparador es `style.overflowY === "auto"`, que es literalmente el
// elemento que se le pasa a `useVirtualizer` (`Words`: el div con la tabla
// dentro). La alternativa, `classList.contains("table")`, enganchaba el
// wrapper externo — la clase es genérica y se renombra sin más, y entonces la
// virtualización se rompía sin que ningún test fallara por la razón correcta.
//
// `offsetHeight` también hace falta: `virtual-core` lee `offsetHeight` del
// elemento medido (`measureElement`) y no `clientHeight`. Sólo el que lleva el
// virtualizador; el resto sigue midiendo 0 como en happy-dom.
if (typeof HTMLElement !== "undefined") {
  const fake = 600;
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return this.style.overflowY === "auto" ? fake : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return this.style.overflowY === "auto" ? fake : 0;
    },
  });
}
