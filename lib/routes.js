var config = require("../config/" + (process.env.NODE_ENV || "development") + ".json"),
    passport = require("passport"),
    auth = require("./auth"),
    banklink = require("./banklink"),
    db = require("./db"),
    ObjectID = require('mongodb').ObjectID,
    util = require("util"),
    urllib = require("url"),
    banks = require("./banks.json"),
    redis = require("redis"),
    redisClient = redis.createClient(config.redis.port, config.redis.host),
    tools = require("./tools"),
    moment = require("moment"),
    pem = require("pem"),
    zipstream = require('zipstream'),
    punycode = require("punycode"),
    Stream = require("stream").Stream,
    accountInfo = require("./account");

moment.lang("et");

// Main router function
module.exports = function(app){
    app.get("/", serveFront);
    app.get("/info", serveInfo);

    app.get("/reset-link", serveResetLink);
    app.post("/reset-link", handleResetLink);

    app.get("/reset-password", serveResetPassword);
    app.post("/reset-password", handleResetPassword);

    app.get("/join", serveJoin);
    app.post("/join", handleJoin);

    app.get("/profile", serveProfile);
    app.post("/profile", handleProfile);

    app.post("/login", passport.authenticate("local", {successRedirect: "/projects", failureRedirect: "/login", failureFlash: true, successFlash: "Oled edukalt sisse logitud"}));
    app.get("/login", serveLogin);
    app.get("/logout", serveLogout);

    app.get("/banklink/:version/:bank", banklink.serveBanklink);
    app.post("/banklink/:version/:bank", banklink.serveBanklink);

    app.get("/banklink/:bank", banklink.serveBanklink);
    app.post("/banklink/:bank", banklink.serveBanklink);

    app.get("/projects/:pageNumber", serveProjects);
    app.get("/projects", serveProjects);

    app.get("/add-project", serveAddProject);
    app.post("/add-project", handleAddProject);

    app.get("/edit-project/:project", serveEditProject);
    app.post("/edit-project", handleEditProject);

    app.get("/delete-project/:project", serveDeleteProject);

    app.get("/project/:project/regenerate", handleRegenerateProjectCertificate);
    app.get('/project/:project/:key([^.]+).pem', serveKey);
    app.get("/project/:project", serveProject);
    app.get("/project/:project/page/:pageNumber", serveProject);
    app.get("/project/:project/page", serveProject);
    app.get("/project/:project/:tab", serveProject);

    app.get("/preview/:payment", servePaymentPreview);

    app.post("/final/:payment", servePaymentFinal);

    app.get("/payment/:payment/scripts/:direction([^.]+).php", servePayment);
    app.get("/payment/:payment", servePayment);

    app.get("/keys", serveKeys);
    app.post("/keys", handleKeys);

    app.get("/api", serveAPI);

    app.get("/api/project", serveAPIListProject);
    app.get("/api/project/:project", serveAPIGetProject);
    app.post("/api/project", serveAPIPostProject);
    app.del("/api/project/:project", serveAPIDeleteProject);

    app.get("/docs/:name", serveDocs);
};

/**
 * Serves frontpage (/) of the website
 *
 * @param {Object} req HTTP Request object
 * @param {Object} req HTTP Response object
 */
function serveFront(req, res){
    serve(req, res, {page: "/", values:{demoPayment: config.demoPayment}});
}

function serveInfo(req, res){
    serve(req, res, {page: "/info"});
}

function serveKeys(req, res){
    serve(req, res, {page: "/keys"});
}

function serveAPI(req, res){
    var query;
    if(req.user){
        query = {$or: [{owner: req.user.id}, {authorized: req.user.id.toLowerCase().trim()}]};
        db.find("project", query, {}, {sort: [["name", "asc"]], limit: 10, skip: 0}, function(err, records){
            serve(req, res, {page: "/api", values:{list: records || [], apiHost: config.apiHost}});
        });
    }else{
        serve(req, res, {page: "/api", values:{list: [], apiHost: config.apiHost}});
    }
    
}

function serveResetLink(req, res){
    serve(req, res, {page: "/reset-link", values: {username: req.query.username || ""}});
}

function serveResetPassword(req, res){
    serve(req, res, {page: "/reset-password", values: {username: req.query.username || "", resetToken: req.query.resetToken || ""}});
}

function serveAddProject(req, res){
    if(!req.user || !req.user.id){
        return res.redirect("/login");
    }
    serve(req, res, {page: "/add-project", values: {
        name: req.query.name || "",
        description: req.query.description || "",
        keyBitsize: Number(req.query.keyBitsize) || 2048,
        soloAlgo: req.query.soloAlgo || "",
        soloAutoResponse: !!(req.query.soloAutoResponse || ""),
        ecUrl: req.query.ecUrl || "",
        authorized: processAuthorized(req.query.authorized || ""),
        ipizzaReceiverName: req.query.ipizzaReceiverName || "",
        ipizzaReceiverAccount: req.query.ipizzaReceiverAccount || "",
        id: req.query.id || "",
        action: "add",
        bank: req.query.bank || "",
        banks: banks,
        validation: {}
    }});
}

function serveProjects(req, res){
    if(!req.user || !req.user.id){
        return res.redirect("/login");
    }

    var pageNumber = Number(req.params.pageNumber || req.query.pageNumber) || 1;

    var query = {$or: [{owner: req.user.id}, {authorized: req.user.id.toLowerCase().trim()}]};

    db.count("project", query, function(err, total){

        var pageCount = Math.ceil(total / config.pagingCount);

        if(pageNumber > pageCount){
            pageNumber = pageCount || 1;
        }

        var start_index = (pageNumber - 1) * config.pagingCount;

        db.find("project", query, {}, {sort: [["name", "asc"]], limit: config.pagingCount, skip: start_index}, function(err, records){
            if(err){
                req.flash("error", err.message || err || "Andmebaasi viga");
                res.redirect("/");
                return;
            }
            serve(req, res, {page: "/projects", values: {
                start_index: start_index,
                pageNumber: pageNumber,
                pageCount: pageCount,
                pagePath: "/projects",
                banks: banks,
                paging: tools.paging(pageNumber, pageCount),
                projects: (records || []).map(function(project){
                    project.formattedDate = project.updatedDate ? moment(project.updatedDate).calendar() : "";
                    return project;
                })
            }});
        });

    });

}

function serveEditProject(req, res){

    if(!req.user || !req.user.id){
        return res.redirect("/login");
    }

    var id = (req.params.project || req.query.project || "").toString();

    if(!id.match(/^[a-fA-F0-9]{24}$/)){
        req.flash("error", "Vigane makselahenduse identifikaator");
        res.redirect("/");
        return;
    }

    db.findOne("project", {_id: new ObjectID(id)}, function(err, record){
        if(err){
            req.flash("error", err.message || err || "Andmebaasi viga");
            res.redirect("/");
            return;
        }
        if(!record){
            req.flash("error", "Sellise identifikaatoriga makselahendust ei leitud");
            res.redirect("/");
            return;
        }
        if(record.owner != req.user.id && record.authorized.indexOf(req.user.id.toLowerCase().trim()) < 0){
            req.flash("error", "Sul ei ole õigusi selle makselahenduse kasutamiseks");
            res.redirect("/");
            return;
        }

        serve(req, res, {page: "/edit-project", values: {
            name: req.body.name || record.name || "",
            description: req.body.description || record.description || "",
            id: id,
            keyBitsize: Number(req.body.keyBitsize) || Number(record.keyBitsize) || 1024,
            soloAlgo: req.body.soloAlgo || record.soloAlgo || "",
            soloAutoResponse: !!(req.body.soloAutoResponse || record.soloAutoResponse || ""),
            ecUrl: req.body.ecUrl || record.ecUrl || "",
            authorized: processAuthorized(req.body.authorized || record.authorized || ""),
            ipizzaReceiverName: req.body.ipizzaReceiverName || record.ipizzaReceiverName || "",
            ipizzaReceiverAccount: req.body.ipizzaReceiverAccount || record.ipizzaReceiverAccount || "",
            action: "modify",
            userCertificate: record.userCertificate,
            bank: req.body.bank || record.bank || "",
            banks: banks,
            validation: {}
        }});
    });
}

function serveDeleteProject(req, res){

    if(!req.user || !req.user.id){
        return res.redirect("/login");
    }

    var id = (req.params.project || req.query.project || "").toString();

    if(!id.match(/^[a-fA-F0-9]{24}$/)){
        req.flash("error", "Vigane makselahenduse identifikaator");
        res.redirect("/");
        return;
    }

    db.findOne("project", {_id: new ObjectID(id)}, function(err, record){
        if(err){
            req.flash("error", err.message || err || "Andmebaasi viga");
            res.redirect("/");
            return;
        }
        if(!record){
            req.flash("error", "Sellise identifikaatoriga makselahendust ei leitud");
            res.redirect("/");
            return;
        }
        if(record.owner != req.user.id && record.authorized.indexOf(req.user.id.toLowerCase().trim()) < 0){
            req.flash("error", "Sul ei ole õigusi selle makselahenduse kasutamiseks");
            res.redirect("/");
            return;
        }

        db.remove("project", {_id: new ObjectID(id)}, function(err, success){
            db.remove("payment", {project: id}, function(err, success){
                req.flash("success", util.format("Makselahendus nimega '%s' on kustutatud", record.name));
                res.redirect("/projects");
                return;
            });
        });
    });
}

function serveProject(req, res){
    if(!req.user || !req.user.id){
        return res.redirect("/login");
    }

    var id = (req.params.project || req.query.project || "").toString(),
        pageNumber = Number(req.params.pageNumber || req.query.pageNumber) || 1;

    if(!id.match(/^[a-fA-F0-9]{24}$/)){
        req.flash("error", "Vigane makselahenduse identifikaator");
        res.redirect("/");
        return;
    }

    db.findOne("project", {_id: new ObjectID(id)}, function(err, record){
        if(err){
            req.flash("error", err.message || err || "Andmebaasi viga");
            res.redirect("/");
            return;
        }
        if(!record){
            req.flash("error", "Sellise identifikaatoriga makselahendust ei leitud");
            res.redirect("/");
            return;
        }
        if(record.owner != req.user.id && record.authorized.indexOf(req.user.id.toLowerCase().trim()) < 0){
            req.flash("error", "Sul ei ole õigusi selle makselahenduse kasutamiseks");
            res.redirect("/");
            return;
        }

        db.count("payment", {project: id}, function(err, total){

            var pageCount = Math.ceil(total / config.pagingCount);

            if(pageNumber > pageCount){
                pageNumber = pageCount || 1;
            }

            var start_index = (pageNumber - 1) * config.pagingCount;

            db.find("payment", {project: id}, {}, {sort: [["date", "desc"]], limit: config.pagingCount, skip: start_index}, function(err, records){
                if(err){
                    req.flash("error", err.message || err || "Andmebaasi viga");
                    res.redirect("/");
                    return;
                }

                serve(req, res, {page: "/project", values: {
                    project: record,
                    banks: banks,
                    tab: req.params.tab || "payments",
                    id: id,

                    start_index: start_index,
                    pageNumber: pageNumber,
                    pageCount: pageCount,
                    pagePath: "/project/" + id + "/page",
                    paging: tools.paging(pageNumber, pageCount),
                    payments: (records || []).map(function(payment){
                        payment.date = moment(payment.date).calendar();
                        payment.amount = tools.formatCurrency(payment.amount, payment.currency || "EUR");
                        payment.typeName = ({"PAYMENT": "Maksekorraldus", "IDENTIFICATION": "Autentimine"})[payment.type] || "";
                        return payment;
                    }),
                    languages: tools.languageNames,
                    countries: tools.countryCodes,
                    labels: tools.processLabels
                }});
            });
        });
    });
}

function servePayment(req, res){
    var id = (req.params.payment || req.query.payment || "").toString();

    if((!req.user || !req.user.id) && id != config.demoPayment){
        return res.redirect("/login");
    }

    if(!req.user){
        req.user = {};
    }

    if(!id.match(/^[a-fA-F0-9]{24}$/)){
        req.flash("error", "Vigane maksekorralduse identifikaator");
        res.redirect("/");
        return;
    }

    db.findOne("payment", {_id: new ObjectID(id)}, function(err, payment){
        if(err){
            req.flash("error", err.message || err || "Andmebaasi viga");
            res.redirect("/");
            return;
        }
        if(!payment){
            req.flash("error", "Sellise identifikaatoriga maksekorraldust ei leitud");
            res.redirect("/");
            return;
        }

        db.findOne("project", {_id: new ObjectID(payment.project)}, function(err, project){
            if(err){
                req.flash("error", err.message || err || "Andmebaasi viga");
                res.redirect("/");
                return;
            }
            if(!project){
                req.flash("error", "Sellise identifikaatoriga makselahendust ei leitud");
                res.redirect("/");
                return;
            }

            if(id != config.demoPayment && project.owner != req.user.id && project.authorized.indexOf(req.user.id.toLowerCase().trim()) < 0){
                req.flash("error", "Sul ei ole õigusi selle makselahenduse kasutamiseks");
                res.redirect("/");
                return;
            }

            if(["send", "send_with_curl", "receive"].indexOf(req.params.direction) >= 0){
                res.forceCharset = payment.charset;
                res.setHeader("Content-Description", "File Transfer");
                res.setHeader("content-type", "text/plain; charset=" + payment.forceCharset);
                res.setHeader("Content-Disposition", util.format("attachment; filename=\"%s\"", req.params.direction + ".php"));
                res.render("scripts/" + req.params.direction + "." + payment.bank + ".ejs", {
                    payment: payment,
                    project: project,
                    bank: banks[project.bank || "ipizza"] || banks.ipizza,
                    signatureOrder: banklink.signatureOrder(payment.bank),
                    googleAnalyticsID: config.googleAnalyticsID
                });
            }else{
                serve(req, res, {page: "/payment", values: {
                    payment: payment,
                    project: project,
                    bank: banks[project.bank],

                    inspect: util.inspect.bind(util),

                    host: urllib.parse(payment.state == "PAYED" ? payment.successTarget : (payment.state == "REJECTED" ? payment.rejectTarget : payment.cancelTarget)).host,

                    date: moment(payment.date).calendar(),
                    amount: tools.formatCurrency(payment.amount, payment.currency || "EUR"),
                    typeName: ({"PAYMENT": "Maksekorraldus", "IDENTIFICATION": "Autentimine"})[payment.type] || "",

                    languages: tools.languageNames,
                    countries: tools.countryCodes,
                    labels: tools.processLabels
                }});
            }
        });
    });
}

/**
 * Serves login page (/login) of the website
 *
 * @param {Object} req HTTP Request object
 * @param {Object} req HTTP Response object
 */
function serveLogin(req, res){
    serve(req, res, {page: "/login", values: {username: req.query.username || ""}});
}

/**
 * Serves logout page (/logout) of the website
 *
 * @param {Object} req HTTP Request object
 * @param {Object} req HTTP Response object
 */
function serveLogout(req, res){
    req.flash("info", "Oled välja logitud");
    req.logout();
    res.redirect("/");
}

function serveJoin(req, res){
    serve(req, res, {page: "/join", values: {
        name: req.query.name || "",
        company: req.query.company || "",
        username: req.query.username || "",
        yubi: req.query.yubi || "",
        useyubi: !!(req.query.useyubi || ""),
        validation: {}
    }});
}

function serveProfile(req, res){
    if(!req.user || !req.user.id){
        return res.redirect("/login");
    }

    serve(req, res, {page: "/profile", values: {
        name: req.query.name || req.user.name || "",
        company: req.query.company || req.user.company || "",
        username: req.user.id || "",
        yubi: req.user.yubi || "",
        useyubi: !!(req.user.useyubi || ""),
        validation: {}
    }});
}

function handleKeys(req, res){
    Object.keys(req.body).forEach(function(key){
        req.body[key] = req.body[key].trim();

        if(key == "commonName"){
            req.body[key] = punycode.toASCII(req.body[key].replace(/^https?:\/+/i, "").
                    split("/").
                    shift().
                    toLowerCase().
                    trim());
        }

        if(key == "hash"){
            if(["sha1", "md5"].indexOf(req.body[key].toLowerCase()) < 0){
                req.body[key] = "sha1";
            }
        }

        if(key == "keyBitsize"){
            req.body[key] = Number(req.body[key].trim()) || 1024;
            if([1024, 2048, 4096].indexOf(req.body[key]) < 0){
                req.body[key] = 1024;
            }
        }

        if(key == "emailAddress"){
            req.body[key] = req.body[key].replace(/@(.*)$/, function(o, domain){
                return "@" + punycode.toASCII(domain.split("/").
                    shift().
                    toLowerCase().
                    trim());
            });
        }

        if(typeof req.body[key] == "string"){
            req.body[key] = tools.removeDiacritics(req.body[key]);
        }

    });

    pem.createCSR(req.body, function(err, keys){
        if(err){
            req.flash("error", err && err.message || err);
            serve(req, res, {page: "/keys"});
            return;
        }

        var zip = zipstream.createZip({ level: 1 }),
            keyStream = new Stream(),
            csrStream = new Stream(),
            chunks = [],
            error = false;

        zip.addFile(keyStream, { name: 'private_key.pem' }, function() {
            zip.addFile(csrStream, { name: 'csr.pem' }, function() {
                zip.finalize();
            });

            csrStream.emit("data", new Buffer(keys.csr, "utf-8"));
            csrStream.emit("end");
         });

        zip.on("error", function(err) {
            error = true;
            req.flash("error", err && err.message || err);
            serve(req, res, {page: "/keys"});
            return;
        });

        zip.on("data", function(chunk){
            if(chunk && chunk.length){
                chunks.push(chunk);
            }
            return true;
        });

        zip.on("end", function(chunk){
            if(error){
                return; // just in case
            }

            if(chunk && chunk.length){
                chunks.push(chunk);
            }

            res.status(200);
            res.setHeader("Content-Description", "File Transfer");
            res.setHeader("Content-Type", "application/octet-stream");
            res.setHeader("Content-Disposition", util.format("attachment; filename=\"%s\"", "banklink.zip"));

            res.send(Buffer.concat(chunks));
        });

        keyStream.emit("data", new Buffer(keys.clientKey, "utf-8"));
        keyStream.emit("end");
    });
}

function handleJoin(req, res){

    var validationErrors = {}, error = false;

    req.body.name = (req.body.name || "").toString().trim();
    req.body.company = (req.body.company || "").toString().trim();

    if(!req.body.name){
        error = true;
        validationErrors.name = "Nime täitmine on kohustuslik";
    }

    if(!req.body.company){
        error = true;
        validationErrors.company = "Ettevõtte nimie täitmine on kohustuslik";
    }

    if(!req.body.username){
        error = true;
        validationErrors.username = "E-posti aadressi täitmine on kohustuslik";
    }

    if(!req.body.password){
        error = true;
        validationErrors.password = "Parooli täitmine on kohustuslik";
    }

    if(req.body.password && !req.body.password2){
        error = true;
        validationErrors.password2 = "Parooli korudse täitmine on kohustuslik";
    }

    if(req.body.password && req.body.password2 && req.body.password != req.body.password2){
        error = true;
        validationErrors.password2 = "Paroolid ei kattu";
    }

    req.body.yubi = (req.body.yubi || "").trim().replace(/.{32}$/, "");
    req.body.useyubi = !!(req.body.useyubi || "");

    if(error){
        serve(req, res, {page: "/join", values: {
            name: req.body.name || "",
            company: req.body.company || "",
            username: req.body.username || "",
            yubi: req.body.yubi || "",
            useyubi: !!(req.body.useyubi || ""),
            validation: validationErrors}});
        return;
    }

    auth.addUser(req.body.username, req.body.password, {name: req.body.name, company: req.body.company, yubi: req.body.yubi, useyubi: !!(req.body.useyubi || "")}, function(err, user, options){
        if(err){
            req.flash("error", "Andmebaasi viga");
            serve(req, res, {page: "/join", values: {
                name: req.body.name || "",
                company: req.body.company || "",
                username: req.body.username || "",
                yubi: req.body.yubi || "",
                useyubi: !!(req.body.useyubi || ""),
                validation: validationErrors}});
            return;
        }
        if(!user){
            validationErrors.username = options.message || "Ei õnnestunud kasutajat luua";
            serve(req, res, {page: "/join", values: {
                name: req.body.name || "",
                company: req.body.company || "",
                username: req.body.username || "",
                yubi: req.body.yubi || "",
                useyubi: !!(req.body.useyubi || ""),
                validation: validationErrors}});
            return;
        }

        req.login(user, function(err) {
            if(err){
                req.flash("info", "Kasutaja on loodud, kuid automaatne sisselogimine ebaõnnestus");
                return res.redirect("/");
            }
            req.flash("success", "Kasutaja on loodud ning oled nüüd sisse logitud");
            return res.redirect("/add-project");
        });
    });
}

function handleProfile(req, res){
    if(!req.user || !req.user.id){
        return res.redirect("/login");
    }

    var validationErrors = {}, error = false;

    req.body.name = (req.body.name || "").toString().trim();
    req.body.company = (req.body.company || "").toString().trim();

    if(!req.body.name){
        error = true;
        validationErrors.name = "Nime täitmine on kohustuslik";
    }

    if(!req.body.company){
        error = true;
        validationErrors.company = "Ettevõtte nimie täitmine on kohustuslik";
    }


    if(req.body.password && !req.body.password2){
        error = true;
        validationErrors.password2 = "Parooli korudse täitmine on parooli vahetamisel kohustuslik";
    }

    if(req.body.password && req.body.password2 && req.body.password != req.body.password2){
        error = true;
        validationErrors.password2 = "Paroolid ei kattu";
    }

    req.body.yubi = (req.body.yubi || "").trim().replace(/.{32}$/, "");
    req.body.useyubi = !!(req.body.useyubi || "");

    if(error){
        serve(req, res, {page: "/profile", values: {
            name: req.body.name || "",
            company: req.body.company || "",
            username: req.user.id || "",
            yubi: req.body.yubi || "",
            useyubi: !!(req.body.useyubi || ""),
            validation: validationErrors}});
        return;
    }

    auth.updateUser(req.user.id, req.body.password, {name: req.body.name, company: req.body.company, yubi: req.body.yubi, useyubi: !!(req.body.useyubi || "")}, function(err, user, options){
        if(err){
            req.flash("error", "Andmebaasi viga");
            serve(req, res, {page: "/profile", values: {
                name: req.body.name || "",
                company: req.body.company || "",
                username: req.user.id || "",
                yubi: req.body.yubi || "",
                useyubi: !!(req.body.useyubi || ""),
                validation: validationErrors}});
            return;
        }
        if(!user){
            validationErrors.username = options.message || "Ei õnnestunud kasutaja profiili uuendada";
            serve(req, res, {page: "/profile", values: {
                name: req.body.name || "",
                company: req.body.company || "",
                username: req.user.id || "",
                yubi: req.body.yubi || "",
                useyubi: !!(req.body.useyubi || ""),
                validation: validationErrors}});
            return;
        }

        req.flash("success", "Profiili andmed on uuendatud");
        return res.redirect("/profile");
    });
}


function handleResetLink(req, res){
    var validationErrors = {}, error = false;

    if(!req.body.username){
        error = true;
        validationErrors.username = "E-posti aadress on määramata";
    }

    if(error){
        serve(req, res, {page: "/reset-link", values: {
            username: req.body.username || "",
            validation: validationErrors}});
        return;
    }

    auth.initializeResetPassword(req.body.username, function(err, status){
        if(err){
            req.flash("error", "Andmebaasi viga");
            serve(req, res, {page: "/reset-link", values: {
                name: req.body.name || "",
                company: req.body.company || "",
                username: req.body.username || "",
                validation: validationErrors}});
            return;
        }

        req.flash("info", "Parooli muutmise link saadeti valitud e-posti aadressile");
        return res.redirect("/login");
    });
}


function handleResetPassword(req, res){
    auth.resetPassword(req.body.username, req.body.resetToken, function(err, status, options){
        if(err){
            req.flash("error", "Andmebaasi viga");
            return res.redirect("/login");
        }

        if(!status){
            req.flash("error", options && options.message || "Parooli vahetamine ebaõnnestus");
            return res.redirect("/login");
        }

        req.flash("info", "Uus parool saadeti valitud e-posti aadressile");
        return res.redirect("/login");
    });
}

function handleAddProject(req, res){
    if(!req.user || !req.user.id){
        return res.redirect("/login");
    }

    var validationErrors = {},
        error = false;

    req.body.id = (req.body.id || "").toString().trim();
    req.body.name = (req.body.name || "").toString().trim();
    req.body.description = (req.body.description || "").toString().trim();
    req.body.bank = (req.body.bank || "").toString().trim();

    req.body.keyBitsize = Number(req.body.keyBitsize) || 1024;

    req.body.soloAlgo = (req.body.soloAlgo || "").toString().toLowerCase().trim();
    req.body.soloAutoResponse = !!((req.body.soloAutoResponse || "").toString().trim());

    req.body.ecUrl = (req.body.ecUrl || "").toString().trim();
    req.body.authorized = processAuthorized(req.body.authorized || "");

    req.body.ipizzaReceiverName = (req.body.ipizzaReceiverName || "").toString().trim();
    req.body.ipizzaReceiverAccount= (req.body.ipizzaReceiverAccount || "").toString().trim();

    if(!req.body.name){
        error = true;
        validationErrors.name = "Makselahenduse nimetuse täitmine on kohustuslik";
    }

    if(!banks[req.body.bank]){
        error = true;
        validationErrors.bank = "Panga tüüp on valimata";
    }

    if(req.body.keyBitsize && [1024, 2048, 4096].indexOf(req.body.keyBitsize) < 0){
        error = true;
        validationErrors.keyBitsize = "Vigane võtme pikkus";
    }

    if(req.body.bank == "nordea" && (!req.body.soloAlgo || ["md5", "sha1", "sha256"].indexOf(req.body.soloAlgo) < 0)){
        error = true;
        validationErrors.soloAlgo = "Vigane algoritm";
    }

    if(req.body.bank == "ec" && (!req.body.ecUrl || !tools.validateUrl(req.body.ecUrl))){
        error = true;
        validationErrors.ecUrl = "Vigane tagasisuunamise aadress, peab olema korrektne URL";
    }

    if(req.body.bank != "nordea"){
        req.body.soloAlgo = "";
        req.body.soloAutoReturn = "";
    }

    if(req.body.bank != "ec"){
        req.body.ecUrl = "";
    }

    if(error){
        serve(req, res, {page: "/add-project", values: {
            name: req.body.name || "",
            description: req.body.description || "",
            keyBitsize: Number(req.body.keyBitsize) || 1024,
            soloAlgo: req.body.soloAlgo || "",
            soloAutoResponse: !!(req.body.soloAutoResponse || ""),
            ecUrl: req.body.ecUrl || "",
            authorized: processAuthorized(req.body.authorized || ""),
            ipizzaReceiverName: req.body.ipizzaReceiverName || "",
            ipizzaReceiverAccount: req.body.ipizzaReceiverAccount || "",
            id: req.body.id || "",
            action: "add",
            bank: req.body.bank || "",
            banks: banks,
            validation: validationErrors}});
        return;
    }

    tools.generateKeys(req.user, 20 * 365, Number(req.body.keyBitsize) || 1024, function(err, userCertificate, bankCertificate){
        if(err){
            req.flash("error", "Sertifikaadi genereerimisel tekkis viga");
            serve(req, res, {page: "/add-project", values: {
                name: req.body.name || "",
                description: req.body.description || "",
                id: req.body.id || "",
                keyBitsize: Number(req.body.keyBitsize) || 1024,
                soloAlgo: req.body.soloAlgo || "",
                soloAutoResponse: !!(req.body.soloAutoResponse || ""),
                bank: req.body.bank || "",
                banks: banks,
                ecUrl: req.body.ecUrl || "",
                authorized: processAuthorized(req.body.authorized || ""),
                ipizzaReceiverName: req.body.ipizzaReceiverName || "",
                ipizzaReceiverAccount: req.body.ipizzaReceiverAccount || "",
                action: "add",
                validation: validationErrors}});
            return;
        }

        var project = {
            name: req.body.name,
            description: req.body.description,
            owner: req.user.id,
            keyBitsize: req.body.keyBitsize,
            soloAlgo: req.body.soloAlgo,
            soloAutoResponse: !!(req.body.soloAutoResponse || ""),
            bank: req.body.bank,
            ecUrl: req.body.ecUrl,
            authorized: processAuthorized(req.body.authorized),
            ipizzaReceiverName: req.body.ipizzaReceiverName,
            ipizzaReceiverAccount: req.body.ipizzaReceiverAccount,
            created: new Date(),
            userCertificate: userCertificate,
            bankCertificate: bankCertificate,
            secret: tools.genClientSecret()
        };

        tools.incrIdCounter(function(err, id){
            if(err){
                req.flash("error", "Andmebaasi viga");
                serve(req, res, {page: "/add-project", values: {
                    name: req.body.name || "",
                    description: req.body.description || "",
                    id: req.body.id || "",
                    keyBitsize: Number(req.body.keyBitsize) || 1024,
                    soloAlgo: req.body.soloAlgo || "",
                    soloAutoResponse: !!(req.body.soloAutoResponse || ""),
                    bank: req.body.bank || "",
                    banks: banks,
                    ecUrl: req.body.ecUrl || "",
                    authorized: processAuthorized(req.body.authorized || ""),
                    ipizzaReceiverName: req.body.ipizzaReceiverName || "",
                    ipizzaReceiverAccount: req.body.ipizzaReceiverAccount || "",
                    action: "add",
                    validation: validationErrors}});
                return;
            }

            if(req.body.bank == "nordea"){
                project.uid = (10000000 + Number(tools.getReferenceCode(id))).toString();
            }else{
                project.uid = "uid" + tools.getReferenceCode(id);
            }

            db.save("project", project, function(err, id){
                if(err){
                    req.flash("error", "Andmebaasi viga");
                    serve(req, res, {page: "/add-project", values: {
                        name: req.body.name || "",
                        description: req.body.description || "",
                        id: req.body.id || "",
                        keyBitsize: Number(req.body.keyBitsize) || 1024,
                        soloAlgo: req.body.soloAlgo || "",
                        soloAutoResponse: !!(req.body.soloAutoResponse || ""),
                        bank: req.body.bank || "",
                        banks: banks,
                        ecUrl: req.body.ecUrl || "",
                        authorized: processAuthorized(req.body.authorized || ""),
                        ipizzaReceiverName: req.body.ipizzaReceiverName || "",
                        ipizzaReceiverAccount: req.body.ipizzaReceiverAccount || "",
                        action: "add",
                        validation: validationErrors}});
                    return;
                }
                if(id){
                    req.flash("success", "Makselahendus on loodud");
                    res.redirect("/project/" + id.toString()+"/certs");
                }else{
                    req.flash("error", "Makselahenduse loomine ebaõnnestus");
                    serve(req, res, {page: "/add-project", values: {
                        name: req.body.name || "",
                        description: req.body.description || "",
                        id: req.body.id || "",
                        keyBitsize: Number(req.body.soloAlgo) || 1024,
                        soloAlgo: req.body.soloAlgo || "",
                        soloAutoResponse: !!(req.body.soloAutoResponse || ""),
                        bank: req.body.bank || "",
                        banks: banks,
                        ecUrl: req.body.ecUrl || "",
                        authorized: processAuthorized(req.body.authorized || ""),
                        ipizzaReceiverName: req.body.ipizzaReceiverName || "",
                        ipizzaReceiverAccount: req.body.ipizzaReceiverAccount || "",
                        action: "add",
                        validation: validationErrors}});
                    return;
                }
            });
        });
    });
}

function handleEditProject(req, res){
    if(!req.user || !req.user.id){
        return res.redirect("/login");
    }

    var validationErrors = {}, error = false;

    req.body.id = (req.body.id || "").toString().trim();
    req.body.name = (req.body.name || "").toString().trim();
    req.body.description = (req.body.description || "").toString().trim();

    req.body.keyBitsize = Number(req.body.keyBitsize) || 1024;

    req.body.soloAlgo = (req.body.soloAlgo || "").toString().toLowerCase().trim();
    req.body.soloAutoResponse = !!((req.body.soloAutoResponse || "").toString().trim());

    req.body.ecUrl = (req.body.ecUrl || "").toString().trim();
    req.body.authorized = processAuthorized(req.body.authorized);

    req.body.ipizzaReceiverName = (req.body.ipizzaReceiverName || "").toString().trim();
    req.body.ipizzaReceiverAccount = (req.body.ipizzaReceiverAccount || "").toString().trim();

    if(!req.body.id.match(/^[a-fA-F0-9]{24}$/)){
        req.flash("error", "Vigane makselahenduse identifikaator");
        res.redirect("/");
        return;
    }

    if(!req.body.name){
        error = true;
        validationErrors.name = "Makselahenduse nimetuse täitmine on kohustuslik";
    }

    db.findOne("project", {_id: new ObjectID(req.body.id)}, function(err, record){
        if(err){
            req.flash("error", err.message || err || "Andmebaasi viga");
            res.redirect("/");
            return;
        }
        if(!record){
            req.flash("error", "Sellise identifikaatoriga makselahendust ei leitud");
            res.redirect("/");
            return;
        }
        if(record.owner != req.user.id && record.authorized.indexOf(req.user.id.toLowerCase().trim()) < 0){
            req.flash("error", "Sul ei ole õigusi selle makselahenduse kasutamiseks");
            res.redirect("/");
            return;
        }

        if(req.body.keyBitsize && [1024, 2048, 4096].indexOf(req.body.keyBitsize) < 0){
            error = true;
            validationErrors.keyBitsize = "Vigane võtme pikkus";
        }

        if(record.bank == "nordea" && (!req.body.soloAlgo || ["md5", "sha1", "sha256"].indexOf(req.body.soloAlgo) < 0)){
            error = true;
            validationErrors.soloAlgo = "Vigane algoritm";
        }

        if(record.bank == "ec" && (!req.body.ecUrl || !tools.validateUrl(req.body.ecUrl))){
            error = true;
            validationErrors.ecUrl = "Vigane tagasisuunamise aadress, peab olema korrektne URL";
        }


        if(record.bank != "nordea"){
            req.body.soloAlgo = "";
            req.body.soloAutoResponse = "";
        }

        if(record.bank != "ec"){
            req.body.ecUrl = "";
        }

        if(error){
            serve(req, res, {page: "/edit-project", values: {
                name: req.body.name || "",
                description: req.body.description || "",
                id: req.body.id || "",
                keyBitsize: Number(req.body.keyBitsize) || 1024,
                soloAlgo: req.body.soloAlgo || "",
                soloAutoResponse: !!(req.body.soloAutoResponse || ""),
                ecUrl: req.body.ecUrl || "",
                authorized: processAuthorized(req.body.authorized || ""),
                ipizzaReceiverName: req.body.ipizzaReceiverName || "",
                ipizzaReceiverAccount: req.body.ipizzaReceiverAccount || "",
                action: "modify",
                bank: req.body.bank || "",
                banks: banks,
                userCertificate: record.userCertificate,
                validation: validationErrors}});
            return;
        }

        tools.generateKeys(req.user, 20 * 365, Number(req.body.keyBitsize) || 1024, function(err, userCertificate, bankCertificate){
            if(err && req.body.regenerate){
                req.flash("error", "Sertifikaadi genereerimisel tekkis viga");
                serve(req, res, {page: "/edit-project", values: {
                    name: req.body.name || "",
                    description: req.body.description || "",
                    id: req.body.id || "",
                    keyBitsize: Number(req.body.keyBitsize) || 1024,
                    soloAlgo: req.body.soloAlgo || "",
                    soloAutoResponse: !!(req.body.soloAutoResponse || ""),
                    ecUrl: req.body.ecUrl || "",
                    authorized: processAuthorized(req.body.authorized || ""),
                    ipizzaReceiverName: req.body.ipizzaReceiverName || "",
                    ipizzaReceiverAccount: req.body.ipizzaReceiverAccount || "",
                    action: "modify",
                    bank: req.body.bank || "",
                    banks: banks,
                    userCertificate: record.userCertificate,
                    validation: validationErrors}});
                return;
            }

            record.name = req.body.name;
            record.description = req.body.description;
            record.updated = new Date();
            record.keyBitsize = Number(req.body.keyBitsize) || 1024;
            record.soloAlgo = req.body.soloAlgo || "";
            record.soloAutoResponse = !!(req.body.soloAutoResponse || "");

            record.ecUrl = req.body.ecUrl || "";
            record.authorized = processAuthorized(req.body.authorized || ""),
            record.ipizzaReceiverName = req.body.ipizzaReceiverName || "";
            record.ipizzaReceiverAccount = req.body.ipizzaReceiverAccount || "";

            if(req.body.regenerate){
                record.userCertificate = userCertificate;
                record.bankCertificate = bankCertificate;
                record.secret = tools.genClientSecret();
            }

            db.save("project", record, function(err, id){
                if(err){
                    req.flash("error", "Andmebaasi viga");
                    serve(req, res, {page: "/edit-project", values: {
                        name: req.body.name || "",
                        description: req.body.description || "",
                        id: req.body.id || "",
                        keyBitsize: Number(req.body.keyBitsize) || 1024,
                        soloAlgo: req.body.soloAlgo || "",
                        soloAutoResponse: !!(req.body.soloAutoResponse || ""),
                        ecUrl: req.body.ecUrl || "",
                        authorized: processAuthorized(req.body.authorized || ""),
                        ipizzaReceiverName: req.body.ipizzaReceiverName || "",
                        ipizzaReceiverAccount: req.body.ipizzaReceiverAccount || "",
                        action: "modify",
                        bank: req.body.bank || "",
                        banks: banks,
                        userCertificate: record.userCertificate,
                        validation: validationErrors}});
                    return;
                }
                if(id){
                    req.flash("success", "Makselahenduse andmed on uuendatud");
                    if(req.body.regenerate){
                        req.flash("success", util.format("Genereeriti uus sertifikaat"));
                    }
                    res.redirect("/project/" + id.toString()+"/certs");
                }else{
                    req.flash("error", "Makselahenduse andmete uuendamine ebaõnnestus");
                    serve(req, res, {page: "/edit-project", values: {
                        name: req.body.name || "",
                        description: req.body.description || "",
                        id: req.body.id || "",
                        keyBitsize: Number(req.body.keyBitsize) || 1024,
                        soloAlgo: req.body.soloAlgo || "",
                        soloAutoResponse: !!(req.body.soloAutoResponse || ""),
                        ecUrl: req.body.ecUrl || "",
                        authorized: processAuthorized(req.body.authorized || ""),
                        ipizzaReceiverName: req.body.ipizzaReceiverName || "",
                        ipizzaReceiverAccount: req.body.ipizzaReceiverAccount || "",
                        action: "modify",
                        bank: req.body.bank || "",
                        banks: banks,
                        userCertificate: record.userCertificate,
                        validation: validationErrors}});
                    return;
                }
            });
        });
    });
}

function serveKey(req, res){
    if(!req.user || !req.user.id){
        return res.redirect("/login");
    }

    var id = (req.params.project || "").toString().trim();

    if(!id.match(/^[a-fA-F0-9]{24}$/)){
        req.flash("error", "Vigane makselahenduse identifikaator");
        res.redirect("/");
        return;
    }

    db.findOne("project", {_id: new ObjectID(id)}, function(err, record){
        if(err){
            req.flash("error", err.message || err || "Andmebaasi viga");
            res.redirect("/");
            return;
        }
        if(!record){
            req.flash("error", "Sellise identifikaatoriga makselahendust ei leitud");
            res.redirect("/");
            return;
        }
        if(record.owner != req.user.id && record.authorized.indexOf(req.user.id.toLowerCase().trim()) < 0){
            req.flash("error", "Sul ei ole õigusi selle makselahenduse kasutamiseks");
            res.redirect("/");
            return;
        }

        var filename = req.params.key + ".pem",
            certificate;

        switch(req.params.key){
            case "user_key":
                certificate = record.userCertificate.clientKey;
                break;
            case "user_cert":
                certificate = record.userCertificate.certificate;
                break;
            case "bank_key":
                certificate = record.bankCertificate.clientKey;
                break;
            case "bank_cert":
                certificate = record.bankCertificate.certificate;
                break;
            default:
                req.flash("error", "Sellist võtmefaili ei leitud");
                res.redirect("/project/" + req.params.project + "/certs");
                return;
        }

        res.status(200);
        res.setHeader("Content-Description", "File Transfer");
        res.setHeader("Content-Type", "application/octet-stream");
        res.setHeader("Content-Disposition", util.format("attachment; filename=\"%s\"", filename));

        res.send(certificate);
    });
}

function handleRegenerateProjectCertificate(req, res){
    if(!req.user || !req.user.id){
        return res.redirect("/login");
    }

    var id = (req.params.project || "").toString().trim();

    if(!id.match(/^[a-fA-F0-9]{24}$/)){
        req.flash("error", "Vigane makselahenduse identifikaator");
        res.redirect("/");
        return;
    }

    db.findOne("project", {_id: new ObjectID(id)}, function(err, record){
        if(err){
            req.flash("error", err.message || err || "Andmebaasi viga");
            res.redirect("/");
            return;
        }
        if(!record){
            req.flash("error", "Sellise identifikaatoriga makselahendust ei leitud");
            res.redirect("/");
            return;
        }
        if(record.owner != req.user.id && record.authorized.indexOf(req.user.id.toLowerCase().trim()) < 0){
            req.flash("error", "Sul ei ole õigusi selle makselahenduse kasutamiseks");
            res.redirect("/");
            return;
        }

        tools.generateKeys(req.user, 20 * 365, record.keyBitsize || 1024, function(err, userCertificate, bankCertificate){
            if(err){
                req.flash("error", "Sertifikaadi genereerimisel tekkis viga");
                res.redirect("/project/" + id.toString()+"/certs");
                return;
            }

            record.userCertificate = userCertificate;
            record.bankCertificate = bankCertificate;
            record.secret = tools.genClientSecret();

            db.save("project", record, function(err, id){
                if(err){
                    req.flash("error", "Andmebaasi viga");
                    res.redirect("/project/" + id.toString()+"/certs");
                    return;
                }

                if(id){
                    req.flash("success", util.format("Genereeriti uus sertifikaat"));
                    res.redirect("/project/" + id.toString()+"/certs");
                }else{
                    req.flash("error", "Makselahenduse andmete uuendamine ebaõnnestus");
                    res.redirect("/project/" + id.toString()+"/certs");
                    return;
                }
            });
        });
    });
}

function servePaymentPreview(req, res){
    var id = (req.params.payment || req.query.payment || "").toString();

    if(!id.match(/^[a-fA-F0-9]{24}$/)){
        req.flash("error", "Vigane maksekorralduse identifikaator");
        res.redirect("/");
        return;
    }

    db.findOne("payment", {_id: new ObjectID(id)}, function(err, record){
        if(err){
            req.flash("error", err.message || err || "Andmebaasi viga");
            res.redirect("/");
            return;
        }
        if(!record){
            req.flash("error", "Sellise identifikaatoriga maksekorraldust ei leitud");
            res.redirect("/");
            return;
        }

        if(record.state != "IN PROCESS"){
            req.flash("error", "Seda maksekorraldust ei saa enam jätkata");
            res.redirect("/");
            return;
        }

        record.amount = tools.formatCurrency(record.amount, tools.currencies[record.currency] || record.currency);

        db.findOne("project", {_id: new ObjectID(record.project)}, function(err, project){
            if(err){
                req.flash("error", err.message || err || "Andmebaasi viga");
                res.redirect("/");
                return;
            }

            if(!project){
                req.flash("error", "Maksekorraldust ei saa kuvada");
                res.redirect("/");
                return;
            }

            db.findOne("user", {id: project.owner}, function(err, user){
                if(err){
                    req.flash("error", err.message || err || "Andmebaasi viga");
                    res.redirect("/");
                    return;
                }

                return res.render("banklink/preview", {
                    payment: record,
                    bank: banks[project.bank],
                    languages: tools.languageNames,
                    countries: tools.countryCodes,
                    project: project,
                    uid: req.user && req.user.id,
                    user: req.user,
                    accountInfo: accountInfo,
                    googleAnalyticsID: config.googleAnalyticsID
                });
            });
        });
    });
}


function servePaymentFinal(req, res){
    var id = (req.params.payment || req.query.payment || "").toString();

    if(!id.match(/^[a-fA-F0-9]{24}$/)){
        req.flash("error", "Vigane maksekorralduse identifikaator");
        res.redirect("/");
        return;
    }

    banklink.makePayment(id, req.body, req.user, function(err, data){
        if(err){
            req.flash("error", err.message || err);
            res.redirect(err.redirectUrl || "/");
            return;
        }

        db.findOne("user", {id: data.project.owner}, function(err, user){
            if(err){
                req.flash("error", err.message || err || "Andmebaasi viga");
                res.redirect("/");
                return;
            }

            res.forceCharset = data.forceCharset;
            res.setHeader("content-type", "text/html; charset=" + data.forceCharset);

            data.googleAnalyticsID = config.googleAnalyticsID;
            data.user = user;
            data.accountInfo = accountInfo;
            return res.render("banklink/final", data);
        });
    });
}

function serveDocs(req, res){
    tools.renderDocs(req.params.name, function(err, content){
        if(err){
            req.flash("error", err.message || err || "Dokumentatsiooni viga");
            res.redirect("/");
            return;
        }
        serve(req, res, {page: "/docs", values:{content: content}});
    });
}

function serve(req, res, options){
    if(typeof options == "string"){
        options = {page: options};
    }

    options = options || {};
    options.status = options.status || 200;
    options.contentType = options.contentType || "text/html";
    options.page = options.page || "/";
    options.title = options.title || false;

    var defaultValues = {
            title: config.title,
            hostname: config.hostname,
            messages: {
                success: req.flash("success"),
                error: req.flash("error"),
                info: req.flash("info")
            },
            pageTitle: options.title,
            page: options.page,
            user: req.user,
            accountInfo: accountInfo,
            googleAnalyticsID: config.googleAnalyticsID
        },
        localValues = options.values || {};

    Object.keys(defaultValues).forEach(function(key){
        if(!(key in localValues)){
            localValues[key] = defaultValues[key];
        }
    });

    res.status(options.status);
    res.setHeader("Content-Type", options.contentType);
    res.render("index", localValues);
}

function processAuthorized(authorized){
    var lines;
    if(!Array.isArray(authorized)){
        authorized = (authorized || "").toString().trim();
        lines = authorized.split("\n");
    }else{
        lines = authorized;
    }

    var result = [];
    lines.forEach(function(line){
        line = line.toLowerCase().trim();
        if(line && result.indexOf(line)<0){
            result.push(line);
        }
    });

    result.sort(function(a,b){
        var partsA = a.split("@"),
            partsB = b.split("@");

        if(partsA[1] != partsB[1]){
            return partsA[1].localeCompare(partsB[1]);
        }else{
            return partsA[0].localeCompare(partsB[0]);
        }
    });

    return result;
}

// API related functions

function apiResponse(req, res, err, data){
    var response = {};

    if(err){
        response.success = false;
        response.error = err.message || err;

        if(err.fields){
            response.fields = err.fields;
        }
    }else{
        response.success = true;
        response.data = data;
    }

    res.status(200);
    res.setHeader("Content-Type", "application/json; charset=utf-8");

    res.end(JSON.stringify(response, null, "    "));
}

function serveAPIListProject(req, res){
    var accessToken = (req.query.access_token || req.headers.access_token || "").toString().trim(),
        start = Number((req.query.start_index || "0").toString().trim()) || 0;

    apiAuthorizeToken(accessToken, req.headers.api_secret, function(err, user){
        if(err){
            return apiResponse(req, res, err);
        }

        apiActionList(user, start, function(err, list){
            if(err){
                return apiResponse(req, res, err);
            }
            apiResponse(req, res, false, list);
        });
    });
}

function serveAPIGetProject(req, res){
    var accessToken = (req.query.access_token || req.headers.access_token || "").toString().trim(),
        projectId = (req.params.project || "").toString().trim();

    apiAuthorizeToken(accessToken, req.headers.api_secret, function(err, user){
        if(err){
            return apiResponse(req, res, err);
        }

        apiActionGet(user, projectId, function(err, project){
            if(err){
                return apiResponse(req, res, err);
            }
            apiResponse(req, res, false, project);
        });
    });
}

function serveAPIPostProject(req, res){
    var accessToken = (req.query.access_token || req.headers.access_token || "").toString().trim();

    apiAuthorizeToken(accessToken, req.headers.api_secret, function(err, user){
        if(err){
            return apiResponse(req, res, err);
        }
        
        var project;

        try{
            project = JSON.parse(req.rawBody.toString("utf-8"));
        }catch(E){
            return apiResponse(req, res, new Error("Invalid input"));
        }

        apiActionPost(user, project, function(err, projectId){
            if(err){
                return apiResponse(req, res, err);
            }
            apiActionGet(user, projectId, function(err, project){
                if(err){
                    return apiResponse(req, res, err);
                }
                apiResponse(req, res, false, project);
            });
        });
    });
}

function serveAPIDeleteProject(req, res){
    var accessToken = (req.query.access_token || req.headers.access_token || "").toString().trim(),
        projectId = (req.params.project || "").toString().trim();

    apiAuthorizeToken(accessToken, req.headers.api_secret, function(err, user){
        if(err){
            return apiResponse(req, res, err);
        }

        apiActionDelete(user, projectId, function(err, deleted){
            if(err){
                return apiResponse(req, res, err);
            }
            apiResponse(req, res, false, deleted);
        });
    });
}

function apiAuthorizeToken(accessToken, apiSecret, callback){
    accessToken = (accessToken || "").toString().trim();

    if(config.apiSecret && config.apiSecret != apiSecret){
        return callback(new Error("Vigane API salaväärtus! Kontrolli, et kasutatav API domeen oleks https://" + (config.apiHost || config.hostname)));
    }

    if(!accessToken.match(/^[a-fA-F0-9]+$/)){
        return callback(new Error("Vigane API võti"));
    }

    db.findOne("user", {token: accessToken}, callback);
}

function apiActionGet(user, projectId, callback){

    projectId = (projectId || "").toString().trim();

    if(!user){
        return callback(new Error("Määramata kasutaja"));
    }

    if(!projectId.match(/^[a-fA-F0-9]{24}$/)){
        return callback(new Error("Vigane makselahenduse identifikaator"));
    }

    db.findOne("project", {_id: new ObjectID(projectId)}, function(err, project){
        var responseObject = {};
        if(err){
            return callback(err || new Error("Andmebaasi viga"));
        }

        if(!project){
            return callback(new Error("Sellise identifikaatoriga makselahendust ei leitud"));
        }

        if(project.owner != user.id && project.authorized.indexOf(user.id.toLowerCase().trim()) < 0){
            return callback(new Error("Sul ei ole õigusi selle makselahenduse kasutamiseks"));
        }

        responseObject.id = project._id.toString();
        responseObject.client_id = project.uid.toString();
        responseObject.payment_url = "https://" + config.hostname + "/banklink/" + project.bank;
        responseObject.type = project.bank;
        responseObject.name = project.name || undefined;
        responseObject.description = project.description || undefined;

        if(banks[project.bank].type == "ipizza"){
            responseObject.account_owner = project.ipizzaReceiverName || undefined;
            responseObject.account_nr = project.ipizzaReceiverAccount || undefined;    
        }
        
        if(["ipizza", "ec"].indexOf(banks[project.bank].type)>=0){
            responseObject.key_size = project.keyBitsize || undefined;
            responseObject.private_key = project.userCertificate.clientKey;
            responseObject.bank_certificate = project.bankCertificate.certificate;
        }

        if(banks[project.bank].type == "ec"){
            responseObject.return_url = project.ecUrl || undefined;
        }

        if(banks[project.bank].type == "solo"){
            responseObject.mac_key = project.secret || undefined;
            responseObject.algo = project.soloAlgo || undefined;
            responseObject.auto_response = !!project.soloAutoResponse;
        }

        return callback(null, responseObject);
    });    
}

function apiActionList(user, start, callback){

    start = start || 0;

    if(!user){
        return callback(new Error("Määramata kasutaja"));
    }

    var query = {$or: [{owner: user.id}, {authorized: user.id.toLowerCase().trim()}]};

    db.count("project", query, function(err, total){
        if(start > total){
            start = Math.floor(total/20) * 20;
        }
        if(start<0){
            start = 0;
        }
        db.find("project", query, {_id: true, name: true, bank: true}, {sort: [["created", "desc"]], limit: 20, skip: start}, function(err, records){
            if(err){
                return callback(err);
            }

            var list = [].concat(records || []).map(function(record){
                return {
                    id: record._id.toString(),
                    name: record.name || undefined,
                    type: record.bank
                }
            });

            callback(null, {
                total: total,
                start_index: start,
                end_index: start + list.length - 1,
                list: list
            });
        });
    });



}


function apiActionPost(user, project, callback){

    if(!user){
        return callback(new Error("Määramata kasutaja"));
    }

    var validationErrors = {},
        error = false;

    project.type = (project.type || "").toString().trim();
    project.name = (project.name || "").toString().trim();
    project.description = (project.description || "").toString().trim();

    project.account_owner = (project.account_owner || "").toString().trim();
    project.account_nr = (project.account_nr || "").toString().trim();

    project.key_size = Number(project.key_size) || 1024;

    project.return_url = (project.return_url || "").toString().trim();

    project.algo = (project.algo || "").toString().toLowerCase().trim();
    if(typeof project.auto_response == "string"){
        project.auto_response = (project.auto_response.toLowerCase().trim() == "true");
    }else{
        project.auto_response = !!project.auto_response;
    }
    
    if(!project.name){
        error = true;
        validationErrors.name = "Makselahenduse nimetuse täitmine on kohustuslik";
    }

    if(!banks[project.type]){
        error = true;
        validationErrors.type = "Panga tüüp on valimata";
    }

    if(project.key_size && [1024, 2048, 4096].indexOf(project.key_size) < 0){
        error = true;
        validationErrors.key_size = "Vigane võtme pikkus";
    }

    if(project.type == "nordea" && (!project.algo || ["md5", "sha1", "sha256"].indexOf(project.algo) < 0)){
        error = true;
        validationErrors.algo = "Vigane algoritm";
    }

    if(project.type == "ec" && (!project.return_url || !tools.validateUrl(project.return_url))){
        error = true;
        validationErrors.return_url = "Vigane tagasisuunamise aadress, peab olema korrektne URL";
    }

    if(project.type != "nordea"){
        project.algo = "";
        project.auto_return = false;
    }

    if(project.type != "ec"){
        project.return_url = "";
    }

    if(error){
        error = new Error("Andmete valideerimisel ilmnesid vead");
        error.fields = validationErrors;
        return callback(error);
    }

    tools.generateKeys(user, 20 * 365, Number(project.key_size) || 1024, function(err, userCertificate, bankCertificate){
        if(err){
            return callback(new Error("Sertifikaadi genereerimisel tekkis viga"));
        }

        var record = {
            name: project.name,
            description: project.description,
            owner: user.id,
            keyBitsize: project.key_size,
            soloAlgo: project.algo,
            soloAutoResponse: !!project.auto_response,
            bank: project.type,
            ecUrl: project.return_url,
            authorized: processAuthorized(""),
            ipizzaReceiverName: project.account_owner,
            ipizzaReceiverAccount: project.account_nr,
            created: new Date(),
            userCertificate: userCertificate,
            bankCertificate: bankCertificate,
            secret: tools.genClientSecret()
        };

        tools.incrIdCounter(function(err, id){
            if(err){
                return callback(new Error("Andmebaasi viga"));
            }

            if(project.type == "nordea"){
                record.uid = (10000000 + Number(tools.getReferenceCode(id))).toString();
            }else{
                record.uid = "uid" + tools.getReferenceCode(id);
            }

            db.save("project", record, function(err, id){
                if(err){
                    return callback(new Error("Andmebaasi viga"));
                }
                if(id){
                    return callback(null, id.toString());
                }else{
                    return callback(new Error("Makselahenduse loomine ebaõnnestus"));
                }
            });
        });
    });
}

function apiActionDelete(user, projectId, callback){

    projectId = (projectId || "").toString().trim();

    if(!user){
        return callback(new Error("Määramata kasutaja"));
    }

    if(!projectId.match(/^[a-fA-F0-9]{24}$/)){
        return callback(new Error("Vigane makselahenduse identifikaator"));
    }

    db.findOne("project", {_id: new ObjectID(projectId)}, function(err, project){
        var responseObject = {};
        if(err){
            return callback(err || new Error("Andmebaasi viga"));
        }

        if(!project){
            return callback(new Error("Sellise identifikaatoriga makselahendust ei leitud"));
        }

        if(project.owner != user.id && project.authorized.indexOf(user.id.toLowerCase().trim()) < 0){
            return callback(new Error("Sul ei ole õigusi selle makselahenduse kasutamiseks"));
        }

        db.remove("project", {_id: new ObjectID(projectId)}, function(err, success){
            if(err){
                return callback(err);
            }

            db.remove("payment", {project: projectId}, function(err, success){
                return callback(null, true);
            });
        });
    });    
}