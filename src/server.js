import { cargarConfig } from './config.js';
import { crearServicio } from './servicio.js';

const config = cargarConfig();
const { app, planificador } = await crearServicio({ config });

const servidor = app.listen(config.puerto, () => {
  console.log(`REsGuarD escuchando en el puerto ${config.puerto}`);
  planificador.iniciar();
});

// Como proceso 1 de un contenedor, Node ignora SIGTERM si nadie la atiende, y
// `docker stop` esperaría diez segundos antes de matarlo. Si había una copia a
// medias, el siguiente arranque la marca como interrumpida y avisa.
for (const señal of ['SIGTERM', 'SIGINT']) {
  process.on(señal, () => {
    planificador.parar();
    servidor.close();
    process.exit(0);
  });
}
