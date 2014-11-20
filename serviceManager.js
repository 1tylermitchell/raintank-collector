'use strict;'
var config = require('./config');
var util = require('util');
var routes = require('./routes');

var io = require('socket.io-client')
serviceCache = {};
var socket;
var metricCount = 0;
setInterval(function() {
    console.log("Processing %s metric/min", metricCount);
    metricCount = 0;
}, 3600000);


var init = function() {
	socket = io(util.format("%s?token=%s&location=%s", config.serverUrl, config.adminToken, config.location));

	socket.on('connect', function(){
	    console.log('connected');
	});

	socket.on('refresh', function(data){
	    serviceRefresh(data);
	});
	socket.on('update', function(data) {
		serviceUpdate(data);
	});
	socket.on('remove', function(data) {
		serviceDelete(data);
	});

	socket.on('connect_error', function(err) {
		console.log("serviceManager connection error");
		console.log(err);
	});

	socket.on('disconnect', function(){
	    console.log("serviceManager disconnected");
	});
}

exports.init = init;
exports.serviceCache = serviceCache;

function serviceUpdate(payload) {
	var service = JSON.parse(payload);
	console.log("got serviceUpdate message for service: %s", service._id);
	if (!(service._id in serviceCache) || service.lastUpdate >= serviceCache[service._id].lastUpdate) {
		service.reschedule = false;
		if (!('timer' in service)) {
			service.timer = setInterval(function() { run(service._id);}, service.frequency*1000);
		} else if (serviceCache[service._id] && service.offset != serviceCache[service._id].offset) {
			service.reschedule = true;
		}
		serviceCache[service._id] = service;
	}
}

function serviceRefresh(payload) {
	var services = JSON.parse(payload);
	console.log("refreshing service list: count: %s", services.length);
	var seen = {};
	services.forEach(function(service) {
		if (!(service._id in serviceCache) || service.lastUpdate >= serviceCache[service._id].lastUpdate) {
			service.reschedule = false;
			if (!('timer' in service)) {
				service.timer = setInterval(function() { run(service._id);}, service.frequency*1000);
			} else if (serviceCache[service._id] && service.offset != serviceCache[service._id].offset) {
				service.reschedule = true;
			}
			serviceCache[service._id] = service;
		}
		seen[service._id] = true;
	});
	Object.keys(serviceCache).forEach(function(id) {
		if (!(id in seen)) {
			clearInterval(serviceCache[id].timer);
			delete serviceCache[id];
		}
	});
}

function serviceDelete(payload) {
	var service = JSON.parse(payload);
	if (service._id in serviceCache) {
		if ('timer' in serviceCache[service.id]) {
			clearInterval(serviceCache[service._id].timer);
		}
		delete serviceCache[service._id];
	}
}

function run(serviceId) {
	var service = serviceCache[serviceId];
	if (service.reschedule) {
		reschedule(serviceId);
	}
	var timestamp = new Date().getTime();
	var route = service.serviceType.toLowerCase();
	if (route in routes) {
		var settings = {};
		service.settings.forEach(function(setting) {
			settings[setting.name] = setting.value;
		});
		routes[route].execute(settings, function(err, response) {
			if  (response.success) {
				var payload = [];
				var events = [];
				var metrics = response.results;
	            if (metrics) {
	                metrics.forEach(function(metric) {
	                    metric.location = config.location
	                    metric.interval = service.frequency;
	                    var pos = 0;
	                    metric.dsnames.forEach(function(dsname) {
	                        payload.push({
	                            name: util.format(
	                                "raintank.service.%s.%s.%s.%s",
	                                service.code,
	                                config.location,
	                                metric.plugin,
	                                dsname
	                            ),
	                            account: service.account,
	                            interval: service.frequency,
	                            units: metric.unit,
	                            target_type: metric.target_type,
	                            value: metric.values[pos],
	                            time: timestamp/1000,
	                            parent: {
	                                class: 'service',
	                                id: service._id,
	                            }
	                        });
	                        pos++;
	                    });
	                });
	            }
	            if (response.error ) {
	            	console.log("error in check. sending event.")
	                socket.emit('serviceEvent', {
	                    account: service.account,
	                    service: service._id,
	                    level: 'critical',
	                    details: config.location + " collector failed: "+service.error,
	                    timestamp: timestamp
	                });
	            }
	            var serviceState = 0;
	            if (events.length > 0) {
	            	serviceState = 2;
	            }
	            var metricName = util.format("raintank.service.%s.%s.%s.collector.state",
	            					service.code, config.location, service.serviceType);
	            payload.push({
	                name: metricName,
	                account: service.account,
	                interval: service.frequency,
	                units: "state",
	                target_type: "gauge",
	                value: serviceState,
	                time: timestamp/1000,
	                parent: {
	                    class: 'service',
	                    id: service._id,
	                }
	            });

	            metricCount = metricCount + payload.length;
	            socket.emit('results', payload);
	        }
		});
	}
}

function reschedule(serviceId) {
	var service = serviceCache[serviceId];
	service.reschedule = false;
	var now = new Date().getTime();
    var seconds = Math.floor(now / 1000);
    clearInterval(service.timer);

    var wait = ((service.frequency + service.offset) - (seconds % service.frequency)) % service.frequency;
    if (wait == 0) {
    	service.timer = setInterval(function() { run(service._id);}, service.frequency*1000);
    } else {
    	setTimeout(function() {
    		setInterval(function() {run(service._id);}, service.frequency * 1000);
    	}, wait * 1000);
    }
}