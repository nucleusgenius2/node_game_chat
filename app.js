const axios= require('axios');
const http = require('http');
const ws = require('ws');
const Joi = require('joi');
const crypto = require('crypto');
require('dotenv').config(); // для env

const secret = process.env.WEBSOCKET_JWT_SECRET;
console.log('старт')

let objectUser = {
  'countUserChat' : 0,
  'usersData' : {},
  'usersList' : {},
};
let newUser = {};

const chatSchema = Joi.object({
    type: Joi.string().min(3).required(),
    data: Joi.string().required(),
    user_id: Joi.number().integer().min(1),
    user: Joi.object({
        name: Joi.string().required(),
        avatar: Joi.string().allow(null),
        level: Joi.number().integer().allow(null),
    }).required()
});

const chatPublicMessageSchema = Joi.object({
    type: Joi.string().min(3).required(),
    data: Joi.string().required(),
    user_id: Joi.number().integer().min(1),
});

const tokenSchema = Joi.string().min(10).required();


const wss = new ws.Server({port: 9999, maxPayload: 1024 * 1024}); //лимит на передачу данных (162 килобайта проходят, а 512 уже нет)
wss.on('connection',onConnect);


function base64UrlDecode(str) {
    // Восстанавливаем Base64 из URL-safe формата
    return Buffer.from(
        str.replace(/-/g, '+').replace(/_/g, '/'),
        'base64'
    ).toString('utf-8');
}

/**
 * Проверка JWT токена
 */
function verifyToken(token) {
    const parts = token.split('.');

    if (parts.length !== 3) {
        return { valid: false, error: 'Не валидный формат токена' };
    }

    const [headerEncoded, payloadEncoded, signatureProvided] = parts;

    // Пересчитываем подпись с использованием того же алгоритма (HS256) и секретного ключа
    const signatureExpected = crypto
        .createHmac('sha256', secret)
        .update(`${headerEncoded}.${payloadEncoded}`)
        .digest('base64')
        .replace(/=/g, '')
        .replace(/\+/g, '-')
        .replace(/\//g, '_');

    //console.log("Ожидаемая подпись:", signatureExpected);

    // Проверка подписи
    if (signatureProvided !== signatureExpected) {
        return { valid: false, error: 'Не валидная подпись' };
    }

    // Декодируем полезную нагрузку (payload)
    const payload = JSON.parse(base64UrlDecode(payloadEncoded));

    // Проверяем срок действия токена
    const currentTime = Math.floor(Date.now() / 1000);
    if (payload.exp < currentTime) {
        return { valid: false, error: 'Срок действия токена истек' };
    }

    return { valid: true, payload };
}

function onConnect(ws,req) { //ws - соединение, req параметры из url запроса
    let url = new URLSearchParams(req.url);
    let userToken = url.get('token');

    let { error, value } = tokenSchema.validate(userToken);
    if (error) {
        console.log("Ошибка валидации:", error.details[0].message);
        ws.close();
    }

    let checkToken = verifyToken(userToken)
    if (checkToken.valid){
        let user = checkToken.payload

        //проверяем есть ли у юзера уже открытый веб сокет (проверка идет по токену и по имени)
        if (objectUser.usersData[user.id]){
            console.log('дубль');
            ws.close();
        }

        let idNewUser = user.id;
        console.log('новый юзер' + idNewUser)
        newUser[idNewUser] = user;

        //записали в объект соединения токен и имя юзера как идентификатор (будет доступен при переборе соединений)
        ws.user_uuid = user.id;

        //сохраняем данные юзера из базы в объект c данными всех юзеров, ключ = id из токена
        objectUser.usersData[idNewUser] = newUser[idNewUser];
        //формируем объект публичных данных юзера, которые можно передавать всем юзерам по веб сокету
        objectUser.usersList[idNewUser] = {
            id: newUser[idNewUser].id,
            name: newUser[idNewUser].name,
        }

    }
    else{
        console.log('ошибка авторизации '+userToken);
        ws.close()
    }

                    
    //срабатывает когда веб сокет получает входящее сообщение
    ws.on('message', function (message) {
        try {
            let data = JSON.parse(message);
            console.log(data)
            //валидация входящей даты
            let close = false;

            //защита от спама данных на веб сокет (данные не чаще чем раз в 300 мс секунды)
            if ( typeof (ws.limit_time) == 'undefined' || typeof (ws.limit_time) == null){
                ws.limit_time = Date.now();
            }
            else{
                let timeout = Date.now() - ws.limit_time;
                if ( timeout < 300 ){
                    //лимит превышен, 2 проверка
                    if ( typeof (ws.limit_time_2) == 'undefined' || typeof (ws.limit_time_2) == null){
                        ws.limit_time_2 = Date.now();
                    }
                    else{
                        let timeout_2 = Date.now() - ws.limit_time_2;
                        if ( timeout_2 < 300 ){
                            close = true;
                        }
                        else{
                            ws.limit_time_2 = Date.now();
                        }
                    }
                }
                else{
                    ws.limit_time = Date.now();
                }
            }


            //рвем связь с юзером приславшим не валидные данные и сделать бан
            if (close){
                console.log('превышен лимит запросов');
                ws.close();
               // ws.terminate();
            }

            //пинги не валидируем
            if(data?.type==='ping'){return}

            // Валидация
            let { error, value } = chatPublicMessageSchema.validate(data);
            if (error) {
                console.log("Ошибка валидации:", error.details[0].message);
                ws.close();
            }
            else {

                if (objectUser.usersList[ws.user_uuid]) {
                    //находим юзера приславшего сообщение в объекте всех юзеров по uuid
                    let user = objectUser.usersList[ws.user_uuid];
                    console.log('сообщение в чат');

                    let dataSend = {
                        "user_id": user.id,
                        "data": data.data,
                        "type": 'publicMessage',
                        "user": {
                            'avatar': '',
                            "name": user.name,
                            "level": 9,
                        }
                    }

                    if (data.type === 'publicMessage') {
                        dataAllSend(dataSend)
                    }
                }
                else{
                    console.log("не зарегистрированный коннект");
                }
            }
        } catch (err) {
            console.error('Ошибка при парсинге данных:', err);
            ws.close();
        }
    });

    //срабатывает при отключении юзера от чата (его сокет обрывается)
    ws.on('close', function() {
        if (typeof (objectUser.usersData[ws.user_uuid]) !== 'undefined') {
            if (objectUser.usersList[ws.user_uuid]?.id) {
                let dataSend = {
                    "type": 'logoutUser',
                    "data": objectUser.usersList[ws.user_uuid],
                }
                //обновляем данные у всех - отправляем имя игрока который вышел из чата
                dataAllSend(dataSend)
            }

            //удаляем юзера из объекта юзеров
            console.log('вышел ' + ws.user_uuid)
            delete objectUser.usersData[ws.user_uuid];

            if (typeof (objectUser.usersList[ws.user_uuid]) !== 'undefined') {
                delete objectUser.usersList[ws.user_uuid];
            }
        }

    });

    ws.on('error', function() {
        console.log('ошибка веб сокета')
    })

}

if (!module.parent) {
  //http.createServer(accept).listen(8082);
} else {
  exports.accept = accept;
}

//интервал отправки данных о новых юзерах (интервал создан для оптимизации нагрузки - меньше переборов на беке и перерендера фронте)
setInterval(() => {

    //проверка есть ли новые юзеры
    if (Object.keys(newUser).length > 0) {
        wss.clients.forEach(function (client) {

            if (client.readyState === 1) {
                console.log('первичное сообщение'+client.user_uuid)
                //уведомление только новых юзеров - отдаем им стартовый объект со списком всех юзеров в чате.
                if (client.user_uuid in newUser) {
                    let objectStarData = {
                        type : 'startDada',
                        users: objectUser.usersList,
                    }
                    client.send(JSON.stringify(objectStarData));
                }
                //всем юзерам (кроме новых) говорим о том, что присоединился новый юзер
                if (!newUser[client.user_uuid]){
                    //перебор объекта новых юзеров
                    for (let key in newUser) {
                        //проверяем что юзер еще закрыл соединение
                        if ( typeof (objectUser.usersList[key]) !== 'undefined' ) {
                            let dataSend = {
                                type: 'addUser',
                                data: objectUser.usersList[key],
                            }
                            client.send(JSON.stringify(dataSend));
                        }
                    }

                }
            }
        });

        //удаление из объекта новых юзеров
        wss.clients.forEach(function (client) {
            if (client.user_uuid in newUser) {
                console.log('удаление нового юзера из объекта ' + client.user_uuid)
                delete newUser[client.user_uuid];
            }
        });

    }
}, "2000");


// Отправка всем подключенным к сокету юзерам
function dataAllSend(dataRequest){

    wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            console.log('отправка '+client.user_uuid);
            client.send(JSON.stringify(dataRequest));
        }
    });
}

// Отправка конкретному юзеру
function dataPersonalSend(dataRequest){

    wss.clients.forEach((client) => {
        if ((client.readyState === WebSocket.OPEN) && (client.user_uuid === dataRequest.user_id)) {
            console.log('отправка персонально '+client.user_uuid);
            client.send(JSON.stringify(dataRequest));
        }
    });
}

//опциональное получение данных из внешних источников, в данном примере http, но по хорошему должен быть rebbit
function httpRequest(req, res) {

    if (req.method === 'POST') {
        console.log('пост');
        let jsonString = '';

        req.on('data', function (data) {
            jsonString += data;
        });

        req.on('end', function () {
            try {
                let dataRequest = JSON.parse(jsonString);

                // Валидация
                let { error, value } = chatSchema.validate(dataRequest);
                if (error) {
                    console.log("Ошибка валидации:", error.details[0].message);

                    res.writeHead(422, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        status: 'error',
                    }));
                    return;
                }

                if( dataRequest.type==='publicMessage' ){
                    dataAllSend(dataRequest)
                }
                if( dataRequest.type==='notificationsMessage' ){
                    dataPersonalSend(dataRequest)
                }

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    status: 'success',
                }));

            } catch (err) {
                console.error('Ошибка при парсинге данных:', err);
                res.writeHead(422, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    status: 'error',
                    message: 'Invalid JSON format'
                }));
            }
        });

    }
}

//слушаем http по 9000 порту
http.createServer(httpRequest).listen(9000);

