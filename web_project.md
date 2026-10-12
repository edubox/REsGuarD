# REsGuarD

Copias de seguridad periódicas de repositorios públicos de GitHub (código, wiki y último release) con instantáneas fechadas en el NAS, salvaguarda ante repos borrados o vaciados y avisos por Telegram.

## Tareas Completadas

- [x] Diseño acordado y spec escrita
- [x] Plan de implementación escrito
- [x] Armazón y base de datos
- [x] Revisión del plan por el usuario
- [x] Nombres y almacén de ficheros
- [x] Retención por días
- [x] Comprobación previa de GitHub
- [x] Copia de código y wiki
- [x] Último release
- [x] Avisos por Telegram
- [x] Planificador
- [x] Ciclo de una copia con salvaguarda
- [x] API HTTP
- [x] Web
- [x] Arranque y despliegue en pm2
- [x] Revisión final de toda la rama y arreglos
- [x] Licencia GPL, README y limpieza de datos de la máquina para publicar
- [x] Publicado en GitHub
- [x] Despliegue con Docker (Dockerfile, compose y comprobación automática en GitHub)

## Tareas Pendientes

- [ ] Configurar token e ID de conversación de Telegram en Ajustes
- [ ] Revisar la web en el navegador (claro, oscuro y móvil)

## Notas

Servicio desplegado bajo pm2 (`resguard`, puerto 3200) y primera copia real hecha y restaurada. La carpeta de destino y los datos de Telegram son de cada instalación y se ponen en «Ajustes». Licencia GPL-3.0-or-later. Publicado en https://github.com/edubox/REsGuarD. Spec y plan en docs/superpowers/.
