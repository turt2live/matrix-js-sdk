"use strict";
var sdk = require("../..");
var EventStatus = sdk.EventStatus;
var HttpBackend = require("../mock-request");
var utils = require("../test-utils");

describe("MatrixClient room timelines", function() {
    var baseUrl = "http://localhost.or.something";
    var client, httpBackend;
    var userId = "@alice:localhost";
    var accessToken = "aseukfgwef";
    var roomId = "!foo:bar";
    var otherUserId = "@bob:localhost";
    var eventData;
    var initialSync = {
        end: "s_5_3",
        presence: [],
        rooms: [{
            membership: "join",
            room_id: roomId,
            messages: {
                start: "f_1_1",
                end: "f_2_2",
                chunk: [
                    utils.mkMessage({
                        room: roomId, user: otherUserId, msg: "hello"
                    })
                ]
            },
            state: [
                utils.mkEvent({
                    type: "m.room.name", room: roomId, user: otherUserId,
                    content: {
                        name: "Old room name"
                    }
                }),
                utils.mkMembership({
                    room: roomId, mship: "join", user: otherUserId, name: "Bob"
                }),
                utils.mkMembership({
                    room: roomId, mship: "join", user: userId, name: "Alice"
                }),
                utils.mkEvent({
                    type: "m.room.create", room: roomId, user: userId,
                    content: {
                        creator: userId
                    }
                })
            ]
        }]
    };

    beforeEach(function() {
        utils.beforeEach(this);
        httpBackend = new HttpBackend();
        sdk.request(httpBackend.requestFn);
        client = sdk.createClient({
            baseUrl: baseUrl,
            userId: userId,
            accessToken: accessToken
        });
        eventData = {
            chunk: [],
            end: "end_",
            start: "start_"
        };
        httpBackend.when("GET", "/initialSync").respond(200, initialSync);
        httpBackend.when("GET", "/events").respond(200, eventData);
    });

    afterEach(function() {
        httpBackend.verifyNoOutstandingExpectation();
    });

    describe("local echo events", function() {

        it("should be added immediately after calling MatrixClient.sendEvent " +
        "with EventStatus.SENDING and the right event.sender", function(done) {
            client.on("syncComplete", function() {
                var room = client.getRoom(roomId);
                expect(room.timeline.length).toEqual(1);

                client.sendTextMessage(roomId, "I am a fish", "txn1");
                // check it was added
                expect(room.timeline.length).toEqual(2);
                // check status
                expect(room.timeline[1].status).toEqual(EventStatus.SENDING);
                // check member
                var member = room.timeline[1].sender;
                expect(member.userId).toEqual(userId);
                expect(member.name).toEqual("Alice");

                httpBackend.flush("/events", 1).done(function() {
                    done();
                });
            });
            client.startClient();
            httpBackend.flush("/initialSync", 1);
        });

        it("should be updated correctly when the send request finishes " +
        "BEFORE the event comes down the event stream", function(done) {
            var eventId = "$foo:bar";
            httpBackend.when("PUT", "/txn1").respond(200, {
                event_id: eventId
            });
            eventData.chunk = [
                utils.mkMessage({
                    body: "I am a fish", user: userId, room: roomId
                })
            ];
            eventData.chunk[0].event_id = eventId;

            client.on("syncComplete", function() {
                var room = client.getRoom(roomId);
                client.sendTextMessage(roomId, "I am a fish", "txn1").done(
                function() {
                    expect(room.timeline[1].getId()).toEqual(eventId);
                    httpBackend.flush("/events", 1).done(function() {
                        expect(room.timeline[1].getId()).toEqual(eventId);
                        done();
                    });
                });
                httpBackend.flush("/txn1", 1);
            });
            client.startClient();
            httpBackend.flush("/initialSync", 1);
        });

        it("should be updated correctly when the send request finishes " +
        "AFTER the event comes down the event stream", function(done) {
            var eventId = "$foo:bar";
            httpBackend.when("PUT", "/txn1").respond(200, {
                event_id: eventId
            });
            eventData.chunk = [
                utils.mkMessage({
                    body: "I am a fish", user: userId, room: roomId
                })
            ];
            eventData.chunk[0].event_id = eventId;

            client.on("syncComplete", function() {
                var room = client.getRoom(roomId);
                var promise = client.sendTextMessage(roomId, "I am a fish", "txn1");
                httpBackend.flush("/events", 1).done(function() {
                    // expect 3rd msg, it doesn't know this is the request is just did
                    expect(room.timeline.length).toEqual(3);
                    httpBackend.flush("/txn1", 1);
                    promise.done(function() {
                        expect(room.timeline.length).toEqual(2);
                        expect(room.timeline[1].getId()).toEqual(eventId);
                        done();
                    });
                });

            });
            client.startClient();
            httpBackend.flush("/initialSync", 1);
        });
    });

    describe("paginated events", function() {
        var sbEvents;
        var sbEndTok = "pagin_end";

        beforeEach(function() {
            sbEvents = [];
            httpBackend.when("GET", "/messages").respond(200, function() {
                return {
                    chunk: sbEvents,
                    start: "pagin_start",
                    end: sbEndTok
                };
            });
        });

        it("should set Room.oldState.paginationToken to null at the start" +
        " of the timeline.", function(done) {
            client.on("syncComplete", function() {
                var room = client.getRoom(roomId);
                expect(room.timeline.length).toEqual(1);

                client.scrollback(room).done(function() {
                    expect(room.timeline.length).toEqual(1);
                    expect(room.oldState.paginationToken).toBeNull();
                    done();
                });

                httpBackend.flush("/messages", 1);
                httpBackend.flush("/events", 1);
            });
            client.startClient();
            httpBackend.flush("/initialSync", 1);
        });

        it("should set the right event.sender values", function(done) {
            // make an m.room.member event with prev_content
            var oldMshipEvent = utils.mkMembership({
                mship: "join", user: userId, room: roomId, name: "Alice",
                url: "mxc://some/url"
            });
            oldMshipEvent.prev_content = {
                displayname: "Old Alice",
                avatar_url: null,
                membership: "join"
            };

            // set the list of events to return on scrollback
            sbEvents = [
                utils.mkMessage({
                    user: userId, room: roomId, msg: "I'm alice"
                }),
                oldMshipEvent,
                utils.mkMessage({
                    user: userId, room: roomId, msg: "I'm old alice"
                })
            ];

            client.on("syncComplete", function() {
                var room = client.getRoom(roomId);
                expect(room.timeline.length).toEqual(1);

                client.scrollback(room).done(function() {
                    expect(room.timeline.length).toEqual(4);
                    var oldMsg = room.timeline[0];
                    expect(oldMsg.sender.name).toEqual("Old Alice");
                    var newMsg = room.timeline[2];
                    expect(newMsg.sender.name).toEqual("Alice");
                    done();
                });

                httpBackend.flush("/messages", 1);
                httpBackend.flush("/events", 1);
            });
            client.startClient();
            httpBackend.flush("/initialSync", 1);
        });

        it("should add it them to the right place in the timeline", function(done) {
            // set the list of events to return on scrollback
            sbEvents = [
                utils.mkMessage({
                    user: userId, room: roomId, msg: "I am new"
                }),
                utils.mkMessage({
                    user: userId, room: roomId, msg: "I am old"
                })
            ];

            client.on("syncComplete", function() {
                var room = client.getRoom(roomId);
                expect(room.timeline.length).toEqual(1);

                client.scrollback(room).done(function() {
                    expect(room.timeline.length).toEqual(3);
                    expect(room.timeline[0].event).toEqual(sbEvents[1]);
                    expect(room.timeline[1].event).toEqual(sbEvents[0]);
                    done();
                });

                httpBackend.flush("/messages", 1);
                httpBackend.flush("/events", 1);
            });
            client.startClient();
            httpBackend.flush("/initialSync", 1);
        });

        it("should use 'end' as the next pagination token", function(done) {
            // set the list of events to return on scrollback
            sbEvents = [
                utils.mkMessage({
                    user: userId, room: roomId, msg: "I am new"
                })
            ];

            client.on("syncComplete", function() {
                var room = client.getRoom(roomId);
                expect(room.oldState.paginationToken).toBeDefined();

                client.scrollback(room, 1).done(function() {
                    expect(room.oldState.paginationToken).toEqual(sbEndTok);
                    done();
                });

                httpBackend.flush("/messages", 1);
                httpBackend.flush("/events", 1);
            });
            client.startClient();
            httpBackend.flush("/initialSync", 1);
        });
    });

    describe("new events", function() {
        xit("should be added to the right place in the timeline", function() {

        });

        xit("should set the right event.sender values", function() {

        });

        xit("should set the right room.name", function() {

        });

        xit("should set the right room members", function() {

        });
    });
});