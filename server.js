var config = require("./config/" + (process.env.NODE_ENV || "development") + ".json"),
    pathlib = require("path"),
    express = require("express"),
    app = express(),
    flash = require("connect-flash"),
    RedisStore = require("connect-redis")(express),
    routes = require("./lib/routes"),
    passport = require("passport"),
    fs = require("fs"),
    https = require("https"),
    http = require("http"),
    querystring = require("querystring"),
    tools = require("./lib/tools"),
    db = require("./lib/db"),
    server;


// Setup SSL
if(config.web.ssl){
    config.web.ssl.key = fs.readFileSync(config.web.ssl.key, "utf-8");
    config.web.ssl.cert = fs.readFileSync(config.web.ssl.cert, "utf-8");

    if(config.web.ssl.ca){
        config.web.ssl.ca = [].concat(config.web.ssl.ca).map(function(ca){
            return fs.readFileSync(ca, "utf-8");
        });
    }
}

// Express.js configuration
app.configure(function(){
    // HTTP port to listen
    app.set("port", config.web.port);

    // Define path to EJS templates
    app.set("views", pathlib.join(__dirname, "www", "views"));

    // Use EJS template engine
    app.set("view engine", "ejs");

    app.use(function(req, res, next){
        if(!config.web.forceDomain){
            return next();
        }

        if(req.header("host") == config.web.forceDomain){
            next();
        }else{
            res.redirect(301, (config.web.forceProtocol || "http" + (config.web.ssl?"s":"")) + "://" + config.web.forceDomain + req.path);
        }
    });

    // Use gzip compression
    app.use(express.compress());

    // if res.forceCharset is set, convert ecoding for output
    app.use(require("./lib/forcecharset"));

    // Parse cookies
    app.use(express.cookieParser(config.session.secret));

    // Parse POST requests
    app.use(require("./lib/bodyparser"));
    app.use(tools.checkEncoding);

    app.use(express.session({
        store: new RedisStore({
            host: config.redis.host,
            db: config.redis.db,
            ttl: config.session.ttl
        }),
        secret: config.session.secret
    }));

    app.use(passport.initialize());

    app.use(passport.session());

    app.use(flash());

    // Use default Espress.js favicon
    app.use(express.favicon());

    // Log requests to console
    app.use(express.logger(config.loggerInterface));

    app.use(app.router);

    // Define static content path
    app.use(express["static"](pathlib.join(__dirname, "www", "static")));

    //Show error traces
    app.use(express.errorHandler());
});

// Use routes from routes.js
routes(app);

if(config.web.ssl){
    server = https.createServer(config.web.ssl, app);
}else{
    server = http.createServer(app);
}

db.init(function(err){
    if(err){
        console.log("Failed opening database");
        console.log(err);
    }else{
        console.log("Database opened");
        server.listen(app.get("port"), function(err){
            if(err){
                console.log("Failed starting web server");
                console.log(err);
            }else{
                console.log("Web server running on port " + app.get("port"));
            }
        });
    }
});
