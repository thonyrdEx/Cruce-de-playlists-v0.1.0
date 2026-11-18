# Cruce de playlists

Aplicación local para cruzar las playlists privadas de tu canal de YouTube. Busca con condiciones **Y/O**, filtra por fechas, consulta miniaturas y exporta los resultados en CSV o ZIP.

## Ejecutar la app

Necesitas [Node.js 22 o posterior](https://nodejs.org/). Clona el repositorio desde **Code** en GitHub o descarga su código fuente. Abre una terminal en la carpeta que contiene `package.json` y ejecuta:

```sh
npm install
npm start
```

Abre [http://localhost:4317](http://localhost:4317) en el navegador. Puedes probar de inmediato los filtros y el CSV con los datos de ejemplo. El proyecto funciona sin dependencias externas de npm. Para cerrar el servidor, pulsa `Ctrl+C` en la terminal.

## Conectar tu canal

1. Crea o selecciona un proyecto en [Google Cloud](https://console.cloud.google.com/) y habilita [YouTube Data API v3](https://console.cloud.google.com/apis/library/youtube.googleapis.com).
2. Configura la pantalla de consentimiento en [Google Auth Platform](https://console.cloud.google.com/auth/overview). Para una cuenta personal, selecciona la audiencia **Externa** y añade como usuario de prueba la cuenta que posee el canal. Configura el permiso `https://www.googleapis.com/auth/youtube.readonly` en **Acceso a datos**.
3. En **Clientes**, crea un cliente OAuth de tipo **Aplicación web**. Añade `http://localhost` y `http://localhost:4317` en **Orígenes autorizados de JavaScript**. [Instrucciones de Google para el cliente web](https://developers.google.com/identity/oauth2/web/guides/get-google-api-clientid)
4. En la app, pulsa **Configurar YouTube**, pega el **ID de cliente** que termina en `.apps.googleusercontent.com` y selecciona **Guardar ID**. Después pulsa **Conectar con Google** y elige la cuenta de tu canal. La app solo necesita el ID público del cliente.

El ID queda guardado en ese navegador para `http://localhost:4317`. La próxima vez puedes entrar directamente con **Conectar con Google**. Con el canal desconectado, abre **Configuración** para cambiar el ID o usa **Olvidar ID** para borrarlo. Si usas otra dirección, perfil de navegador o equipo, guarda allí el ID una vez.

La app solicita permiso de lectura. El servidor local mantiene el token de acceso en memoria y abre la misma sesión al recargar la página, mientras Node.js siga abierto y el token esté vigente. Si cierras el servidor o vence el acceso, vuelve a pulsar **Conectar con Google**.

## Catálogo guardado

Al conectar tu canal por primera vez, la app sincroniza las playlists. Las siguientes visitas con el canal autorizado abren la copia local y muestran **Última sincronización**. Usa **Actualizar** para consultar los cambios en YouTube. La copia está asociada al canal e incluye playlists, metadatos, fechas y URL de miniaturas. Se guarda en `%LOCALAPPDATA%/cruce-de-playlists` en Windows, o bajo `$XDG_CACHE_HOME` o `~/.cache` en otros sistemas, y caduca a los 29 días.

**Borrar caché** retira ese catálogo de la pantalla y del disco, con la sesión de Google activa. Después puedes volver a cargarlo con **Actualizar**. **Desconectar** cierra la sesión local, borra su catálogo y solicita a Google que revoque el permiso. También puedes revocar el acceso desde los [permisos de tu cuenta de Google](https://myaccount.google.com/permissions). El uso de la integración queda sujeto a los [Términos de YouTube](https://www.youtube.com/t/terms) y a la [Política de privacidad de Google](https://policies.google.com/privacy).

## Probar los filtros

- Para `system`, elige **+ Categoría** y selecciona `system`. Verás `v01` y `v05`.
- Para `(cocina O system) Y Slife_of_life`, elige **Todas (Y)** en el filtro principal. Añade `Slife_of_life` como categoría y crea un grupo con **Cualquiera (O)** que contenga `cocina` y `system`. Verás `v01` y `v03`.
- En **Fechas**, un rango de incorporación a `system` del 11 al 11 de octubre de 2025 devuelve `v01`. La misma fecha con `Slife_of_life` devuelve cero videos. Las fechas se interpretan en la zona horaria del navegador y los límites son inclusivos. Sin rango, el selector de incorporación no aplica ningún filtro.
- **Fechas de incorporación** debajo de cada video muestra todas las fechas encontradas por playlist.
- El selector **Vista** permite mostrar **24**, **48** o **96 por página**, o activar el **Desplazamiento infinito**. La elección se recuerda en ese navegador. En modo infinito aparecen nuevas tandas al bajar o al pulsar **Cargar más**. Al cambiar los filtros, vuelves al inicio de los resultados.
- Los filtros buscan en todo el catálogo. Tanto el CSV como el ZIP de resultados filtrados abarcan todas las coincidencias, incluidas las que queden en otras páginas o aún no se hayan mostrado al desplazarte.

## Exportar a CSV

Pulsa **Exportar** junto al contador de videos y elige **Descargar CSV**. **Resultados filtrados** incluye todas las páginas de la búsqueda y las playlists asociadas a cada video. **Playlist completa** incluye todos los videos de la lista elegida. **Todas las playlists privadas** incluye los videos de todas las listas privadas cargadas, independientemente de la búsqueda.

El archivo se descarga localmente. Tiene una fila por combinación de video y playlist, con sus ID, título, enlace, fechas en formato ISO 8601 y la URL de la miniatura de mayor resolución disponible. Si el mismo video se agregó varias veces a una playlist, su columna de incorporación conserva las distintas fechas separadas por ` | `. En la tarjeta de un video conectado, **Abrir miniatura** muestra la imagen para guardarla con el navegador. Los CSV de ejemplo se identifican en el nombre del archivo.

## Descargar miniaturas en ZIP

Con el canal conectado, selecciona el alcance en **Exportar** y pulsa **ZIP de miniaturas**. El ZIP incluye una imagen por ID, con nombres como `ID_DEL_VIDEO.jpg`. La columna **ID del video** del CSV permite relacionar todas las filas del video con el mismo archivo, aunque figure en varias playlists.

El servidor local descarga y transmite las imágenes por tandas usando las URL de YouTube. Las exportaciones grandes pueden tardar. Si falta una imagen, YouTube no la entrega o el ZIP se acerca a 4 GiB, el archivo incluye un informe con los ID omitidos.

## Pruebas

```sh
npm test
```

Las pruebas usan datos simulados y cubren filtros, paginación de catálogos grandes, importación de YouTube y exportaciones CSV y ZIP. GitHub Actions las ejecuta en Windows y Linux con Node.js 22, 24 y 26. Para probar con tu canal, conecta YouTube y exporta un video que esté en dos playlists. Su ID debe aparecer dos veces en el CSV y una vez en el ZIP.

## Solución de problemas

- **Google muestra `origin_mismatch`.** Registra `http://localhost:4317` en los orígenes autorizados de JavaScript y abre la app con esa dirección exacta.
- **Google deniega el acceso en modo Pruebas.** Agrega la cuenta del canal en **Audiencia → Usuarios de prueba** del mismo proyecto donde habilitaste la API.
- **El puerto `4317` está ocupado o el ZIP devuelve `404`.** Detén la instancia anterior desde su terminal con `Ctrl+C`, vuelve a ejecutar `npm start` y recarga la página.

## Licencia y créditos

Código bajo la [licencia MIT](LICENSE). Desarrollado por **thonyrd**, con asistencia de **OpenAI Codex**.
