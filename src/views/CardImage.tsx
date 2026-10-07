import { useEffect, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "../db";

/**
 * La imagen de una palabra, si tiene. Componente aparte y no un `if (media)`
 * dentro de `Study`: `Study` ya está en CC 23 y cada rama lo empuja más alto
 * sin añadir lógica. Aquí la complejidad es 1 y el llamador inserta una línea.
 *
 * Se lee con `useLiveQuery` como `senses` (`Study.tsx`): `Node` y `StudyItem`
 * no cambian de forma y ningún test de estructura se entera.
 *
 * La URL se crea y se revoca en este componente. Sin caché global: una caché
 * exigiría revocar en algún cleanup central que no existe, y una URL por
 * montaje es lo que ya hace `exportToDisk` (crear, usar, revocar). El `revoke`
 * va en el cleanup del mismo `useEffect` que crea, así que no hay camino que
 * lo pierda al desmontar.
 */
export default function CardImage({ nodeId }: { nodeId: number }) {
  const media = useLiveQuery(() => db.media.where("nodeId").equals(nodeId).first(), [nodeId]);
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!media) {
      setUrl(null);
      return;
    }
    // `type` explícito: `mimeOf` ya filtró al importar, pero el backup es un
    // JSON que el usuario puede editar a mano y un `mime` mentiroso pinta
    // cualquier cosa. El Blob lleva el suyo y el navegador decide.
    const blob = new Blob([media.bytes as BlobPart], { type: media.mime });
    const objectUrl = URL.createObjectURL(blob);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [media]);

  if (!media || !url) return null;
  return (
    <img
      src={url}
      alt=""
      className="card-image"
      loading="lazy"
      decoding="async"
      onError={(e) => {
        // Bytes corruptos que sí pasaron el import: la imagen se esconde y la
        // card sigue funcionando. Sin esto, el icono de imagen rota ocupa la
        // card entera y no hay forma de repasar la palabra.
        e.currentTarget.style.display = "none";
      }}
    />
  );
}
