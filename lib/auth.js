var config = require("../config/" + (process.env.NODE_ENV || "development") + ".json"),
    passport = require("passport"),
    auth = require("./auth"),
    LocalStrategy = require("passport-local").Strategy,
    crypto = require("crypto"),
    mail = require("./mail"),
    db = require("./db"),
    util = require("util"),
    yub = require('yub');

yub.init(config.yubikey.client_id, config.yubikey.secret_key);

module.exports.addUser = addUser;
module.exports.updateUser = updateUser;
module.exports.loadUserData = loadUserData;
module.exports.initializeResetPassword = initializeResetPassword;
module.exports.resetPassword = resetPassword;

passport.use(new LocalStrategy(
    function(username, password, done) {
        var validationError;

        password = (password || "").toString();
        username = (username || "").toString().toLowerCase().trim();

        if((validationError = validateCredential("e-mail", username, true))){
            return done(null, false, {message: validationError});
        }

        if((validationError = validateCredential("parool", password))){
            return done(null, false, {message: validationError});
        }

        if(!username || !password){
            return done(null, false, {message: "Tundmatu e-posti aadress või parool"});
        }

        generateKey(username, password, function(err, key){
            loadUserData(username, function(err, user){
                if(err){
                    return done(err);
                }

                if(!user || user.pass != key || (user.yubi && user.useyubi)){

                    validateYubi(password, user.yubi, function(err, data){
                        if(err || !data || !data.valid){
                            return done(null, false, {message: "Tundmatu e-posti aadress või parool"});
                        }
                        return done(null, user);
                    });

                }else{
                    return done(null, user);    
                }
            });
        });
    }
));

passport.serializeUser(function(user, done) {
    done(null, user.id);
});

passport.deserializeUser(function(id, done) {
      loadUserData(id, function(err, user){
          if(err){
              return done(err);
          }
          if(user){
              delete user.pass;
          }
          return done(null, user);
      });
});

function loadUserData(username, callback){
    db.findOne("user", {id: username}, callback);
}

function addUser(username, password, data, callback){

    if(!callback && typeof data == "function"){
        callback = data;
        data = undefined;
    }

    password = (password || "").toString();
    username = (username || "").toString().toLowerCase().trim();
    data = data || {};

    if(!username || !password){
        return callback(null, false, {message: "Vigane e-posti aadress või parool"});
    }

    loadUserData(username, function(err, user){
        if(err){
            return callback(err);
        }

        if(user){
            return callback(null, false, {message: "Valitud e-posti aadress on juba kasutusel. Kas unustasid oma parooli?"});
        }

        generateKey(username, password, function(err, key){
            if(err){
                return callback(err);
            }

            var user = {
                id: username,
                pass: key,
                joined: new Date(),
                token: crypto.randomBytes(20).toString("hex"),
                account: {
                    type: "free",
                    expires: false
                },
                validated: false,
                reset: false
            };

            Object.keys(data).forEach(function(key){
                user[key] = data[key];
            });

            db.save("user", user, function(err, status){
                if(err){
                    return callback(err);
                }
                mail.sendRegistration(user);
                loadUserData(username, callback);
            });

        });
    });
}

function updateUser(username, password, data, callback){

    if(!callback && typeof data == "function"){
        callback = data;
        data = undefined;
    }

    password = (password || "").toString();
    username = (username || "").toString().toLowerCase().trim();
    data = data || {};

    loadUserData(username, function(err, user){
        if(err){
            return callback(err);
        }

        if(!user){
            return callback(null, false, {message: "Tundmatu kasutaja"});
        }

        generateKey(username, password, function(err, key){
            if(err){
                return callback(err);
            }

            if(password){
                user.pass = key;
            }

            Object.keys(data).forEach(function(key){
                user[key] = data[key];
            });

            db.save("user", user, function(err, status){
                if(err){
                    return callback(err);
                }
                return callback(null, user);
            });
        });
    });
}

function initializeResetPassword(username, callback){
    username = (username || "").toString().toLowerCase().trim();

    if(!username){
        return callback(null, false, {message: "Vigane e-posti aadress"});
    }

    loadUserData(username, function(err, user){
        if(err){
            return callback(err);
        }

        if(!user){
            return callback(null, true);
        }

        user.resetToken = crypto.randomBytes(20).toString("hex");
        user.resetExpires = new Date(Date.now() + 3600 * 1000 * 24);

        db.save("user", user, function(err, status){
            if(err){
                return callback(err);
            }

            mail.sendResetLink(user, user.resetToken);

            return callback(null, true);
        });

    });
}

function resetPassword(username, resetToken, callback){
    username = (username || "").toString().toLowerCase().trim();
    resetToken = (resetToken || "").toString().trim();

    if(!username){
        return callback(null, false, {message: "Vigane e-posti aadress"});
    }

    loadUserData(username, function(err, user){
        if(err){
            return callback(err);
        }

        if(!user){
            return callback(null, false, {message: "Vigane e-posti aadress"});
        }

        if(!user.resetToken || resetToken != user.resetToken){
            return callback(null, false, {message: "Tundmatu parooli uuendamise kood"});
        }

        if(!user.resetExpires || user.resetExpires < new Date()){
            return callback(null, false, {message: "Kasutatud parooli uuendamise kood on aegunud"});
        }

        var password = crypto.randomBytes(4).toString("hex");

        generateKey(username, password, function(err, key){
            if(err){
                return callback(err);
            }

            user.pass = key;
            user.resetToken = false;
            user.resetExpires = false;

            db.save("user", user, function(err, status){
                if(err){
                    return callback(err);
                }

                mail.sendPassword(user, password);

                return callback(null, true);
            });

        });
    });
}

function generateKey(username, password, callback){
    crypto.pbkdf2(password, username, 40000, 24, function(err, key){
        if(err){
            return callback(err);
        }

        key = new Buffer((key || "").toString("binary"), "binary").toString("hex");
        return callback(null, key);
    });
}

function validateCredential(type, credential, email){

    if(!credential){
        return "Tühi " + type;
    }

    if(typeof credential != "string"){
        return util.format("Vigane %s väärtus", type);
    }

    if(credential.length > 64){
        return util.format("%s on pikem kui 64 sümbolit", type);
    }

    if(email && !validateEmail(credential)){
        return "Vigane e-posti aadress";
    }
    return false;
}

function validateEmail(email){
    var re = /^(([^<>()\[\]\\.,;:\s@\"]+(\.[^<>()\[\]\\.,;:\s@\"]+)*)|(\".+\"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/;
    return re.test(email);
}

function validateYubi(password, identity, callback){
    if(!identity){
        return callback(new Error("Invalid Yubikey"));
    }
    yub.verify(password, function(err,data) {
        if(err){
            return callback(err);
        }
        if(!data || !data.valid || data.identity != identity){
            return callback("Auth failed");
        }
        return callback(null, data);
    });
}
