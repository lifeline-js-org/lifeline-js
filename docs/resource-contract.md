# Quais informações identificam um recurso?
Um recurso é um objeto que pode ser identificado por um identificador único. Um identificador único pode ser um nome, um endereço, um código, um número de identificação ou qualquer outra coisa que permita identificar um recurso.

# Quais operações são obrigatórias e quais são opcionais?
As operações obrigatórias são aquelas que devem ser implementadas em todos os recursos. As operações opcionais são aquelas que podem ser implementadas em recursos específicos, mas que não são obrigatórias.

# Como representar as dependências?
As dependências são representadas por um conjunto de identificadores de recursos. Cada identificador de recurso é associado a um tipo de dependência, que pode ser uma dependência obrigatória ou opcional.

# Quais estados um recurso pode assumir?
Um recurso pode assumir vários estados. Cada estado é associado a um conjunto de operações permitidas e um conjunto de operações proibidas.

# O comportamento quando uma opração falha?
Quando uma operação falha, o recurso deve assumir um estado de falha. O comportamento da operação que falhou é registrado no estado de falha.

# Como coordenador saberá se o recurso foi iniciado com sucesso?
O coordenador deve ser capaz de saber se o recurso foi iniciado com sucesso. Isso pode ser feito através de um estado de sucesso ou de uma mensagem de log.

# Quando um recurso pode começar a inicializar?
Um recurso pode começar a inicializar quando o coordenador o inicia. O coordenador pode iniciar o recurso de várias maneiras, como por exemplo, chamando o método `start()` ou `init()`.

# Como o gerenciador descobre a ordem correta?
O gerenciador deve ser capaz de descobrir a ordem correta de inicialização dos recursos. Isso pode ser feito através de um sistema de dependência, onde os recursos são associados a outros recursos e são inicializados em ordem de dependência.

# Como ele distingue um recurso iniciado de um que falhou?
Um recurso iniciado é um recurso que foi iniciado com sucesso. Um recurso falhado é um recurso que falhou ao iniciar.

# Quais recursos precisam ser encerrados em cada cenário?
Cada cenário pode ter um ou mais recursos que precisam ser encerrados. Isso pode ser feito através de um método `close()` ou `destroy()`.

# O que acontece quando várias chamadas de encerramento chegam ao mesmo tempo?
Quando várias chamadas de encerramento chegam ao mesmo tempo, o recurso deve aguardar até que todas as chamadas de encerramento sejam concluídas antes de encerrar. Isso pode ser feito através de um mecanismo de bloqueio ou de sincronização.