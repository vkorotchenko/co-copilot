// Independent acceptance tests for the firmware completion-latch contract.
#include <ArduinoJson.h>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <sstream>
#include <string>
#include "completion_latch_json.h"
#include "session_pals.h"
#include "transcript_state.h"

static int checks=0, failures=0, criterion=0, cc[40]={}, cf[40]={};
static const char* caseName=""; static std::string root;
static void check(bool ok,const char* e,const char* f,int l){checks++;cc[criterion]++;if(ok)return;failures++;cf[criterion]++;std::printf("  FAIL [C%02d %s] %s (%s:%d)\n",criterion,caseName,e,f,l);}
#define CHECK(x) check((x),#x,__FILE__,__LINE__)
#define EQ(a,b) check((a)==(b),#a " == " #b,__FILE__,__LINE__)
static void begin(int c,const char* n){criterion=c;caseName=n;std::printf("- C%02d %s\n",c,n);}
static std::string readFile(const std::string& p){std::ifstream in(p,std::ios::binary);if(!in){std::printf("FATAL: cannot open %s\n",p.c_str());std::exit(2);}std::ostringstream o;o<<in.rdbuf();return o.str();}
static CompletionApplyResult apply(const std::string& line,CompletionMirror& m,uint32_t now){JsonDocument d;DeserializationError e=deserializeJson(d,line);CHECK(!e);return e?COMPLETION_MALFORMED:completionApplySnapshot(d.as<JsonVariantConst>(),m,now);}
struct State{CompletionLatch latch;uint32_t epoch,highest,suppressed,pendingEpoch,pendingGeneration;bool epochKnown,active,intro,pending,legacyPrimed,legacyCompleted,modern;};
static State stateOf(const CompletionMirror&m){return{m.latch,m.epoch,m.highestGeneration,m.suppressedGeneration,m.pendingEpoch,m.pendingGeneration,m.epochKnown,m.active,m.introConsumed,m.pendingDismiss,m.legacyPrimed,m.legacyCompleted,m.modern};}
static bool same(const State&a,const State&b){return std::memcmp(&a.latch,&b.latch,sizeof(a.latch))==0&&a.epoch==b.epoch&&a.highest==b.highest&&a.suppressed==b.suppressed&&a.pendingEpoch==b.pendingEpoch&&a.pendingGeneration==b.pendingGeneration&&a.epochKnown==b.epochKnown&&a.active==b.active&&a.intro==b.intro&&a.pending==b.pending&&a.legacyPrimed==b.legacyPrimed&&a.legacyCompleted==b.legacyCompleted&&a.modern==b.modern;}
static const char* OWNED="{\"sg\":41,\"sc\":{\"g\":7,\"o\":0,\"i\":\"0123456789ab\",\"p\":17,\"c\":[0,1,32768,65534,65535],\"m\":\"finished\",\"d\":48}}";
static CompletionMirror seeded(){CompletionMirror m;m.reset();JsonDocument d;deserializeJson(d,OWNED);completionApplySnapshot(d.as<JsonVariantConst>(),m,1000);return m;}
static std::string owner(const std::string&f){return"{\"sg\":41,\"sc\":{\"g\":8,\"o\":0,"+f+"}}";}
static void malformedUnchanged(const std::string&line){CompletionMirror m=seeded();m.pendingDismiss=true;m.pendingEpoch=41;m.pendingGeneration=6;State before=stateOf(m);EQ(apply(line,m,2000),COMPLETION_MALFORMED);CHECK(same(before,stateOf(m)));}

struct CarouselProbe {
  char selectedId[SESSION_ID_LEN + 1];
  int selectedIndex;
  uint32_t lastCarouselMs;
  char previousIds[MAX_SESSION_PALS][SESSION_ID_LEN + 1];
  uint8_t previousStates[MAX_SESSION_PALS];
  uint8_t previousCount;
};

static bool sameCarousel(const CarouselProbe& a, const CarouselProbe& b) {
  return std::memcmp(&a, &b, sizeof(a)) == 0;
}

static void setPal(SessionPalSet& set, uint8_t at, const char* id, uint8_t state) {
  std::strcpy(set.pals[at].id, id);
  set.pals[at].state = state;
}

static void selectionUpdateProbe(const SessionPalSet& set, CarouselProbe& probe, uint32_t now) {
  if (set.count == 0) {
    probe.selectedIndex = -1;
    probe.selectedId[0] = 0;
    probe.previousCount = 0;
    return;
  }
  bool browsing = probe.lastCarouselMs && (now - probe.lastCarouselMs) < 15000u;
  int focus = -1;
  for (uint8_t i = 0; i < set.count && focus < 0; i++) {
    if (!sessionStateNeedsAttention(set.pals[i].state)) continue;
    bool known = false, wasNeedy = false;
    for (uint8_t j = 0; j < probe.previousCount; j++) {
      if (std::strcmp(probe.previousIds[j], set.pals[i].id) != 0) continue;
      known = true;
      wasNeedy = sessionStateNeedsAttention(probe.previousStates[j]);
      break;
    }
    if (!known || !wasNeedy) focus = i;
  }
  if (focus >= 0 && !browsing) std::strcpy(probe.selectedId, set.pals[focus].id);
  probe.selectedIndex = sessionSelectionResolve(set, probe.selectedId, sizeof(probe.selectedId));
  probe.previousCount = set.count;
  for (uint8_t i = 0; i < set.count; i++) {
    std::strcpy(probe.previousIds[i], set.pals[i].id);
    probe.previousStates[i] = set.pals[i].state;
  }
}

static void selectionFrameProbe(bool completionVisible, const SessionPalSet& set,
                                CarouselProbe& probe, uint32_t now) {
  if (!completionVisible) selectionUpdateProbe(set, probe, now);
}

static void carouselInputProbe(bool completionVisible, const SessionPalSet& set,
                               CarouselProbe& probe, int steps, uint32_t now) {
  if (completionVisible) return;
  probe.selectedIndex = sessionSelectionStep(
    set, probe.selectedId, sizeof(probe.selectedId), steps);
  probe.lastCarouselMs = now;
}

struct AttentionFrameResult {
  bool completionVisible;
  bool selectedPersonaActive;
  uint8_t effectivePersona;
  bool needsHuman;
  bool ringVisible;
  bool chirp;
  bool urgent;
};

struct AttentionFacts {
  bool any;
  bool anyBlocked;
};

static AttentionFacts setAttentionFacts(const SessionPalSet& set) {
  AttentionFacts facts = { false, false };
  for (uint8_t i = 0; i < set.count; i++) {
    const uint8_t state = set.pals[i].state;
    if (sessionStateNeedsAttention(state)) facts.any = true;
    if (state == SESS_BLOCKED) facts.anyBlocked = true;
  }
  return facts;
}

static AttentionFrameResult attentionFrameProbe(
    const CompletionMirror& completion, const SessionPalSet& set,
    CarouselProbe& probe, uint8_t aggregatePersona, bool promptLive,
    bool aggregateWaiting, bool recentlyCompleted, uint32_t now,
    uint32_t lastChirp) {
  const AttentionFacts currentAttention = setAttentionFacts(set);
  const bool attentionFacts = aggregateWaiting || currentAttention.any;
  const bool completionVisible = completionCardVisible(
    completion.active, true, true, false, false, promptLive,
    attentionFacts, false);
  selectionFrameProbe(completionVisible, set, probe, now);

  const bool selectedPersonaActive = !completionVisible
    && probe.selectedIndex >= 0 && probe.selectedIndex < (int)set.count
    && !recentlyCompleted;
  const uint8_t selectedPersona = selectedPersonaActive
    ? sessionStateToPersona(set.pals[probe.selectedIndex].state)
    : aggregatePersona;
  const uint8_t effectivePersona = sessionEffectivePersona(
    aggregatePersona, promptLive, selectedPersonaActive, selectedPersona);
  const bool needsHuman = sessionNeedsHuman(
    promptLive, attentionFacts, effectivePersona);
  return {
    completionVisible,
    selectedPersonaActive,
    effectivePersona,
    needsHuman,
    sessionAttentionRingVisible(promptLive, attentionFacts, effectivePersona),
    needsHuman && now - lastChirp > sessionChirpIntervalMs(promptLive),
    sessionAttentionRingUrgent(promptLive, currentAttention.anyBlocked),
  };
}

struct DismissRetryProbe {
  CompletionMirror mirror;
  bool priorConnected;
  std::string writes[8];
  uint8_t writeCount;

  void reset() { mirror = seeded(); priorConnected = true; writeCount = 0; }

  void sendPending() {
    if (!mirror.pendingDismiss) return;
    char payload[112];
    std::snprintf(payload, sizeof(payload),
      "{\"cmd\":\"completion\",\"sg\":%lu,\"g\":%lu,\"action\":\"dismiss\"}\n",
      (unsigned long)mirror.pendingEpoch, (unsigned long)mirror.pendingGeneration);
    writes[writeCount++] = payload;
  }

  void dismiss() { if (mirror.dismissLocal()) sendPending(); }

  void pollLink(bool connected) {
    if (connected && !priorConnected && mirror.pendingDismiss) sendPending();
    if (priorConnected && !connected) mirror.onDisconnect();
    priorConnected = connected;
  }
};

static void wire(){
 begin(1,"strict sg and no mutation");for(const char*line:{"{}","{\"sg\":0}","{\"sg\":-1}","{\"sg\":1.5}","{\"sg\":\"41\"}","{\"sg\":true}","{\"sg\":null}","{\"sg\":4294967296}"}){CompletionMirror m=seeded();State b=stateOf(m);auto r=apply(line,m,2);CHECK(r==COMPLETION_NO_MODERN||r==COMPLETION_MALFORMED);CHECK(same(b,stateOf(m)));}CompletionMirror max=seeded();EQ(apply("{\"sg\":4294967295}",max,2),COMPLETION_UNCHANGED);EQ(max.epoch,UINT32_MAX);
 begin(2,"strict generation and outcome");for(const char*line:{"{\"sg\":41,\"sc\":{\"o\":0}}","{\"sg\":41,\"sc\":{\"g\":8}}","{\"sg\":41,\"sc\":{\"g\":-1,\"o\":0}}","{\"sg\":41,\"sc\":{\"g\":1.5,\"o\":0}}","{\"sg\":41,\"sc\":{\"g\":\"8\",\"o\":0}}","{\"sg\":41,\"sc\":{\"g\":8,\"o\":-1}}","{\"sg\":41,\"sc\":{\"g\":8,\"o\":1.5}}","{\"sg\":41,\"sc\":{\"g\":8,\"o\":\"1\"}}","{\"sg\":41,\"sc\":{\"g\":8,\"o\":3}}"})malformedUnchanged(line);for(uint32_t o=0;o<=2;o++){CompletionMirror m=seeded();EQ(apply("{\"sg\":41,\"sc\":{\"g\":8,\"o\":"+std::to_string(o)+"}}",m,2),COMPLETION_NEW);EQ(m.latch.outcome,o);}
 begin(3,"atomic owner tuple and byte boundaries");for(const char*f:{"\"i\":\"0123456789ab\"","\"p\":0,\"c\":[0,1,2,3,4],\"m\":\"x\"","\"i\":\"0123456789a\",\"p\":0,\"c\":[0,1,2,3,4],\"m\":\"x\"","\"i\":\"0123456789abc\",\"p\":0,\"c\":[0,1,2,3,4],\"m\":\"x\"","\"i\":\"0123456789AB\",\"p\":0,\"c\":[0,1,2,3,4],\"m\":\"x\"","\"i\":\"0123456789ag\",\"p\":0,\"c\":[0,1,2,3,4],\"m\":\"x\"","\"i\":\"0123456789ab\",\"p\":18,\"c\":[0,1,2,3,4],\"m\":\"x\"","\"i\":\"0123456789ab\",\"p\":0,\"c\":[0,1,2,3],\"m\":\"x\"","\"i\":\"0123456789ab\",\"p\":0,\"c\":[0,1,2,3,4,5],\"m\":\"x\""})malformedUnchanged(owner(f));for(uint32_t p:{0u,17u}){CompletionMirror m=seeded();std::string f="\"i\":\"0123456789ab\",\"p\":"+std::to_string(p)+",\"c\":[0,1,2,3,65535],\"m\":\"x\"";EQ(apply(owner(f),m,2),COMPLETION_NEW);EQ(m.latch.species,p);}std::string pre="\"i\":\"0123456789ab\",\"p\":0,\"c\":[0,1,2,3,4],\"m\":\"";CompletionMirror m48=seeded();EQ(apply(owner(pre+std::string(48,'a')+"\""),m48,2),COMPLETION_NEW);malformedUnchanged(owner(pre+std::string(49,'a')+"\""));CompletionMirror u=seeded();EQ(apply(owner(pre+std::string(46,'a')+"\xc2\xa2\""),u,2),COMPLETION_NEW);malformedUnchanged(owner(pre+std::string(47,'a')+"\xc2\xa2\""));CompletionMirror euro=seeded();EQ(apply(owner(pre+std::string(45,'a')+"\xe2\x82\xac\""),euro,2),COMPLETION_NEW);malformedUnchanged(owner(pre+std::string(46,'a')+"\xe2\x82\xac\""));malformedUnchanged(owner(pre+"ok\\u0000tail\""));CompletionMirror no=seeded();EQ(apply("{\"sg\":41,\"sc\":{\"g\":8,\"o\":2}}",no,2),COMPLETION_NEW);CHECK(!(no.latch.flags&COMPLETION_HAS_OWNER));
 begin(4,"optional duration boundaries");for(uint64_t d:{uint64_t(0),uint64_t(UINT32_MAX)}){CompletionMirror m=seeded();EQ(apply("{\"sg\":41,\"sc\":{\"g\":8,\"o\":0,\"d\":"+std::to_string(d)+"}}",m,2),COMPLETION_NEW);EQ(m.latch.durationSeconds,d);CHECK(m.latch.flags&COMPLETION_HAS_DURATION);}CompletionMirror absent=seeded();EQ(apply("{\"sg\":41,\"sc\":{\"g\":8,\"o\":0}}",absent,2),COMPLETION_NEW);CHECK(!(absent.latch.flags&COMPLETION_HAS_DURATION));for(const char*d:{"-1","1.5","\"1\"","null","4294967296"})malformedUnchanged("{\"sg\":41,\"sc\":{\"g\":8,\"o\":0,\"d\":"+std::string(d)+"}}");
 begin(5,"missing sc clears malformed sc is inert");CompletionMirror clear=seeded();clear.pendingDismiss=true;EQ(apply("{\"sg\":41}",clear,2),COMPLETION_CLEARED);CHECK(!clear.active&&!clear.pendingDismiss);EQ(clear.highestGeneration,7u);EQ(clear.suppressedGeneration,7u);for(const char*s:{"null","[]","1","true","\"x\""})malformedUnchanged("{\"sg\":41,\"sc\":"+std::string(s)+"}");
}

static void transitions(){
 begin(6,"same generation idempotent");CompletionMirror m=seeded();State before=stateOf(m);EQ(apply(OWNED,m,999999),COMPLETION_UNCHANGED);CHECK(same(before,stateOf(m)));
 begin(7,"new generation cancels prior dismissal");for(int ordering=0;ordering<4;ordering++){CompletionMirror next=seeded();CHECK(next.dismissLocal());if(ordering==1)next.onDisconnect();if(ordering==2)EQ(apply("{\"sg\":41,\"sc\":{\"g\":6,\"o\":1}}",next,2),COMPLETION_STALE);if(ordering==3){EQ(apply("{\"sg\":41}",next,2),COMPLETION_CLEARED);CHECK(!next.pendingDismiss);}EQ(apply("{\"sg\":41,\"sc\":{\"g\":8,\"o\":2}}",next,3),COMPLETION_NEW);EQ(next.latch.generation,8u);CHECK(!(next.latch.flags&COMPLETION_HAS_OWNER));CHECK(!next.pendingDismiss);EQ(next.pendingEpoch,0u);EQ(next.pendingGeneration,0u);}CompletionMirror epoch=seeded();CHECK(epoch.dismissLocal());EQ(apply("{\"sg\":42,\"sc\":{\"g\":1,\"o\":0}}",epoch,4),COMPLETION_NEW);CHECK(!epoch.pendingDismiss);EQ(epoch.pendingEpoch,0u);EQ(epoch.pendingGeneration,0u);
 begin(8,"stale generation never resurrects");CompletionMirror stale=seeded();EQ(apply("{\"sg\":41}",stale,2),COMPLETION_CLEARED);State cleared=stateOf(stale);EQ(apply("{\"sg\":41,\"sc\":{\"g\":6,\"o\":0}}",stale,3),COMPLETION_STALE);CHECK(same(cleared,stateOf(stale)));CompletionMirror newer=seeded();EQ(apply("{\"sg\":41,\"sc\":{\"g\":8,\"o\":1}}",newer,2),COMPLETION_NEW);State newest=stateOf(newer);EQ(apply(OWNED,newer,4),COMPLETION_STALE);CHECK(same(newest,stateOf(newer)));
 begin(9,"epoch clears first");CompletionMirror e=seeded();e.pendingDismiss=true;EQ(apply("{\"sg\":42,\"sc\":{\"g\":1,\"o\":1}}",e,5),COMPLETION_NEW);EQ(e.epoch,42u);EQ(e.highestGeneration,1u);CHECK(!e.pendingDismiss);CHECK(!(e.latch.flags&COMPLETION_HAS_OWNER));EQ(apply("{\"sg\":43}",e,6),COMPLETION_UNCHANGED);EQ(e.highestGeneration,0u);
 begin(10,"reset canonical and 87-byte slot");CompletionMirror dirty,empty;std::memset(&dirty,0xa5,sizeof(dirty));std::memset(&empty,0,sizeof(empty));dirty.reset();empty.reset();CHECK(same(stateOf(dirty),stateOf(empty)));EQ(sizeof(CompletionLatch),size_t(87));
}

static void legacyConnection(){
 begin(11,"legacy first sample primes");for(bool v:{false,true}){CompletionMirror m;m.reset();EQ(m.observeLegacy(v,false,1),COMPLETION_UNCHANGED);CHECK(m.legacyPrimed&&!m.active);}
 begin(12,"legacy rising edge only");CompletionMirror m;m.reset();bool seq[]={false,false,true,true,false,true};int events=0;uint32_t first=0;for(int i=0;i<6;i++){auto r=m.observeLegacy(seq[i],false,100+i);if(r==COMPLETION_NEW){events++;if(!first)first=m.latch.startedAt;}if(i==3)EQ(m.latch.startedAt,first);}EQ(events,2);
 begin(13,"semantic new work clears");for(int i=0;i<3;i++){CompletionMirror x;x.reset();x.observeLegacy(false,false,1);x.observeLegacy(true,false,2);EQ(x.observeLegacy(false,true,3),COMPLETION_CLEARED);CHECK(!x.active);}SessionPalSet b,a;sessionPalsClear(b);sessionPalsClear(a);b.count=a.count=1;std::strcpy(b.pals[0].id,"0123456789ab");std::strcpy(a.pals[0].id,"0123456789ab");b.pals[0].state=SESS_IDLE;a.pals[0].state=SESS_WORKING;CHECK(sessionPalsNewWorking(b,a));
 begin(14,"keepalive and reorder preserve");CompletionMirror k;k.reset();k.observeLegacy(false,false,1);k.observeLegacy(true,false,2);State latched=stateOf(k);EQ(k.observeLegacy(true,false,999),COMPLETION_UNCHANGED);CHECK(same(latched,stateOf(k)));sessionPalsClear(b);sessionPalsClear(a);b.count=a.count=2;std::strcpy(b.pals[0].id,"aaaaaaaaaaaa");std::strcpy(b.pals[1].id,"bbbbbbbbbbbb");b.pals[0].state=SESS_WORKING;b.pals[1].state=SESS_WAITING;a.pals[0]=b.pals[1];a.pals[1]=b.pals[0];CHECK(!sessionPalsNewWorking(b,a));
 begin(15,"disconnect retains floor and ack");CompletionMirror d=seeded();d.dismissLocal();d.active=true;State prior=stateOf(d);d.onDisconnect();CHECK(!d.active&&d.introConsumed&&d.pendingDismiss);EQ(d.epoch,prior.epoch);EQ(d.highestGeneration,prior.highest);State once=stateOf(d);d.onDisconnect();CHECK(same(once,stateOf(d)));
 begin(16,"reconnect settled no replay");CompletionMirror r=seeded();uint32_t started=r.latch.startedAt;r.onDisconnect();EQ(apply(OWNED,r,9000),COMPLETION_RESTORED);CHECK(r.active&&r.introConsumed);EQ(r.latch.startedAt,started);CHECK(!completionIntroActive(r,9000));
}

static void dismissalInput(){std::string main=readFile(root+"/firmware/src/main.cpp");
 begin(17,"dismissal correlation and resend");DismissRetryProbe retry;retry.reset();retry.dismiss();EQ(retry.writeCount,1u);EQ(retry.writes[0],std::string("{\"cmd\":\"completion\",\"sg\":41,\"g\":7,\"action\":\"dismiss\"}\n"));retry.pollLink(true);retry.pollLink(true);EQ(retry.writeCount,1u);retry.pollLink(false);CHECK(retry.mirror.pendingDismiss);retry.pollLink(false);EQ(retry.writeCount,1u);retry.pollLink(true);EQ(retry.writeCount,2u);EQ(retry.writes[1],retry.writes[0]);retry.pollLink(true);EQ(retry.writeCount,2u);EQ(apply("{\"sg\":41,\"sc\":{\"g\":8,\"o\":0}}",retry.mirror,5),COMPLETION_NEW);CHECK(!retry.mirror.pendingDismiss);retry.pollLink(false);retry.pollLink(true);EQ(retry.writeCount,2u);CHECK(main.find("{\\\"cmd\\\":\\\"completion\\\",\\\"sg\\\":%lu,\\\"g\\\":%lu,\\\"action\\\":\\\"dismiss\\\"}")!=std::string::npos);CHECK(main.find("bleWrite((const uint8_t*)\"\\n\", 1)")!=std::string::npos);CHECK(main.find("if (delivered) tama.completion.dismissDelivered()")==std::string::npos);CHECK(main.find("if (bleLink && !lastBleLink && tama.completion.pendingDismiss) sendCompletionDismiss();")!=std::string::npos);
 begin(18,"watchdog rollover");CompletionMirror w;w.reset();EQ(apply("{\"sg\":1,\"sc\":{\"g\":1,\"o\":0}}",w,0xfffffff0u),COMPLETION_NEW);CHECK(!w.watchdog(0xfffffff1u));CHECK(!w.watchdog(uint32_t(0xfffffff0u+COMPLETION_WATCHDOG_MS-1u)));CHECK(w.watchdog(uint32_t(0xfffffff0u+COMPLETION_WATCHDOG_MS)));w.reset();EQ(apply("{\"sg\":2,\"sc\":{\"g\":1,\"o\":0}}",w,0xf0000000u),COMPLETION_NEW);CHECK(!w.watchdog(0xf0000001u));CHECK(w.watchdog(uint32_t(0xf0000000u+COMPLETION_WATCHDOG_MS)));
 begin(19,"short click gate");CHECK(completionDismissGestureAllowed(completionCardVisible(true,true,true,false,false,false,false,false),true,false,false,false));for(int i=0;i<7;i++){bool v=completionCardVisible(true,i!=0,i!=1,i==2,i==3,i==4,i==5,i==6);CHECK(!v);CHECK(!completionDismissGestureAllowed(v,true,false,false,false));}
 begin(20,"pill bounds and gate");CHECK(main.find("x >= CX - COMPLETION_PILL_W / 2 && x <= CX + COMPLETION_PILL_W / 2")!=std::string::npos);CHECK(main.find("y >= COMPLETION_PILL_Y && y <= COMPLETION_PILL_Y + COMPLETION_PILL_H")!=std::string::npos);CHECK(completionDismissGestureAllowed(true,false,true,false,false));CHECK(!completionDismissGestureAllowed(false,false,true,false,false));
 begin(21,"encoder long press never dismiss");CHECK(!completionDismissGestureAllowed(true,false,false,true,false));CHECK(!completionDismissGestureAllowed(true,true,false,false,true));CHECK(!completionDismissGestureAllowed(true,true,false,true,false));CHECK(!completionDismissGestureAllowed(true,false,true,true,false));CHECK(main.find("if (longPress) {")!=std::string::npos);CHECK(main.find("if (enc != 0) {")!=std::string::npos);
 begin(22,"screen-off gesture wakes only");CHECK(main.find("if (wasOff && anyInput) wakeInputGuard.woke(now, buttonDown);")!=std::string::npos);CHECK(main.find("enc = 0; click = false; touched = false; longPress = false; fastSpin = false;")!=std::string::npos);
 WakeInputGuard g;begin(23,"button wake through release");g.reset();g.woke(1000,true);CHECK(g.consume(1700,true,false,false));CHECK(g.consume(1800,false,false,false));CHECK(g.consume(1949,false,false,false));CHECK(!g.consume(1950,false,false,false));
 begin(24,"encoder touch 150ms quiet");g.reset();g.woke(2000,false);CHECK(g.consume(2100,false,true,false));CHECK(g.consume(2249,false,false,false));CHECK(!g.consume(2250,false,false,false));g.woke(3000,false);CHECK(g.consume(3149,false,false,true));CHECK(g.consume(3298,false,false,false));CHECK(!g.consume(3299,false,false,false));}

static void presentation(){std::string main=readFile(root+"/firmware/src/main.cpp"),data=readFile(root+"/firmware/src/data.h"),xfer=readFile(root+"/firmware/src/xfer.h"),stats=readFile(root+"/firmware/src/stats.h");
 begin(25,"priority plus prompt attention");CHECK(main.find("if (otaActive()) {")<main.find("bool completionVisible = completionCardVisible("));DisplayOwnershipState priority;priority.screenVisible=true;priority.passkeyVisible=true;priority.promptVisible=true;priority.clockVisible=true;priority.completionVisible=true;priority.liveCardVisible=true;priority.hudEnabled=true;priority.connected=true;priority.transcriptRows=2;CHECK(displaySurfaceOwner(priority)==DISPLAY_SURFACE_PASSKEY);priority.passkeyVisible=false;CHECK(displaySurfaceOwner(priority)==DISPLAY_SURFACE_PROMPT);priority.promptVisible=false;priority.clockVisible=false;CHECK(displaySurfaceOwner(priority)==DISPLAY_SURFACE_COMPLETION);priority.completionVisible=false;CHECK(displaySurfaceOwner(priority)==DISPLAY_SURFACE_LIVE_CARD);CHECK(main.find("case DISPLAY_SURFACE_PASSKEY:    drawPasskey(); break;")!=std::string::npos);CHECK(main.find("case DISPLAY_SURFACE_PROMPT:     drawApproval(); break;")!=std::string::npos);CHECK(main.find("case DISPLAY_SURFACE_COMPLETION: drawCompletionCard(now); break;")!=std::string::npos);CHECK(main.find("case DISPLAY_SURFACE_LIVE_CARD:  drawSessionCard(); break;")!=std::string::npos);CHECK(sessionEffectivePersona(SESS_PERSONA_IDLE,true,true,SESS_PERSONA_BUSY)==SESS_PERSONA_ATTENTION);CHECK(sessionNeedsHuman(true,false,SESS_PERSONA_IDLE));CHECK(sessionNeedsHuman(false,true,SESS_PERSONA_IDLE));CHECK(sessionAttentionRingVisible(true,false,SESS_PERSONA_IDLE));CHECK(main.find("bool needsHuman = sessionNeedsHuman(")!=std::string::npos);CHECK(main.find("bool ringVisible = sessionAttentionRingVisible(")!=std::string::npos);
 begin(26,"modal hide no dismiss");CompletionMirror modal=seeded();uint32_t started=modal.latch.startedAt;CHECK(!completionCardVisible(true,true,true,false,false,true,false,false));modal.introConsumed=true;CHECK(completionCardVisible(true,true,true,false,false,false,false,false));CHECK(modal.active&&modal.latch.startedAt==started);CHECK(!completionIntroActive(modal,started+100));
 begin(27,"kind celebrates and assertive redirects");CompletionMirror success=seeded();CHECK(completionIntroActive(success,1000));CHECK(completionIntroActive(success,6599));CHECK(!completionIntroActive(success,6600));EQ(completionIntroDuration(COMPLETION_SUCCESS),5600u);CHECK(main.find("if (completionSettled) buddyTickStill(renderState);")!=std::string::npos);CompletionMirror modernOwnerless;modernOwnerless.reset();EQ(apply("{\"sg\":9,\"sc\":{\"g\":1,\"o\":0}}",modernOwnerless,100),COMPLETION_NEW);CHECK(!(modernOwnerless.latch.flags&COMPLETION_HAS_OWNER));CHECK(!completionIntroActive(modernOwnerless,5700));CompletionMirror legacyOwnerless;legacyOwnerless.reset();legacyOwnerless.observeLegacy(false,false,1);EQ(legacyOwnerless.observeLegacy(true,false,100),COMPLETION_NEW);CHECK(!(legacyOwnerless.latch.flags&COMPLETION_HAS_OWNER));CHECK(!completionIntroActive(legacyOwnerless,5700));CHECK(main.find("characterSetState(renderState);")!=std::string::npos);CHECK(main.find("if (!characterFrameRendered()) {")!=std::string::npos);CHECK(main.find("characterSetFrozen(false);\n        characterTick();")!=std::string::npos);CHECK(main.find("characterSetFrozen(true);")!=std::string::npos);CHECK(main.find("else buddyTick(renderState);")!=std::string::npos);CHECK(main.find("bool kindCompletion = completionVisible")!=std::string::npos);CHECK(main.find("settings().attitude == ATTITUDE_KIND")!=std::string::npos);CHECK(main.find("renderState = kindCompletion ? P_CELEBRATE : P_ATTENTION;")!=std::string::npos);CHECK(main.find("else if (kindCompletion)")!=std::string::npos);CHECK(main.find("buddyTickCompletionCelebrate")!=std::string::npos);CHECK(stats.find("ATTITUDE_KIND = 0")!=std::string::npos);CHECK(stats.find("ATTITUDE_ASSERTIVE = 1")!=std::string::npos);
 begin(28,"interruption consumes intro");CompletionMirror interrupted=seeded();CHECK(completionIntroActive(interrupted,1100));interrupted.introConsumed=true;CHECK(!completionIntroActive(interrupted,1200));CHECK(!completionIntroActive(interrupted,7000));
 begin(29,"failed aborted quiet boundaries");for(uint8_t o:{uint8_t(COMPLETION_FAILED),uint8_t(COMPLETION_ABORTED)}){CompletionMirror q;q.reset();EQ(apply("{\"sg\":1,\"sc\":{\"g\":1,\"o\":"+std::to_string(o)+"}}",q,100),COMPLETION_NEW);uint32_t d=o==COMPLETION_FAILED?800u:400u;CHECK(completionIntroActive(q,100+d-1));CHECK(!completionIntroActive(q,100+d));}CHECK(main.find("else if (kindCompletion)")!=std::string::npos);
 begin(30,"captured owner survives live row reuse");CHECK(main.find("buddySetSessionPal(tama.completion.latch.species, tama.completion.latch.colors)")!=std::string::npos);CompletionMirror captured=seeded();CompletionLatch original=captured.latch;SessionPalSet live;std::memset(&live,0xcc,sizeof(live));sessionPalsClear(live);live.count=1;std::strcpy(live.pals[0].id,"0123456789ab");std::strcpy(live.pals[0].summary,"reused row");sessionPalsClear(live);std::memset(&live.pals[0],0xdd,sizeof(live.pals[0]));CHECK(std::memcmp(&captured.latch,&original,sizeof(original))==0);
 begin(31,"completion copy and ownerless neutral badge");size_t draw=main.find("static void drawCompletionCard"),end=main.find("// Pulsing attention ring",draw);std::string card=main.substr(draw,end-draw);CHECK(card.find("buddyMode ? buddySpeciesName() : petName()")!=std::string::npos);CHECK(card.find("const char* label = \"FINISHED\";")!=std::string::npos);CHECK(card.find("uint16_t pill = dim;")!=std::string::npos);CHECK(card.find("COMPLETION_SUCCESS && owner")!=std::string::npos);CHECK(card.find("settings().attitude == ATTITUDE_ASSERTIVE")!=std::string::npos);CHECK(card.find("GET BACK TO WORK!!")!=std::string::npos);CHECK(card.find("if (assertive)")!=std::string::npos);CHECK(card.find("sessionSummaryDisplay")!=std::string::npos);
 begin(32,"visible-card isolation and genuine attention precedence");
 size_t selectedStart=main.find("bool selectedPersonaActive =");
 size_t selectedEnd=main.find("uint8_t selectedPersona =",selectedStart);
 std::string selectedBlock=main.substr(selectedStart,selectedEnd-selectedStart);
 CHECK(selectedBlock.find("!completionVisible")!=std::string::npos);
 CHECK(selectedBlock.find("selSessionIdx < (int)tama.sessions.count")!=std::string::npos);
 size_t attentionStart=main.find("bool needsHuman = sessionNeedsHuman(");
 size_t attentionEnd=main.find("// Prompt arrival",attentionStart);
 std::string attentionBlock=main.substr(attentionStart,attentionEnd-attentionStart);
 CHECK(attentionBlock.find("tama.completion.active")==std::string::npos);
 CHECK(main.find("if (!completionVisible && !tokenHeartPlaying) sessionSelectionUpdate(now);")!=std::string::npos);
 CHECK(main.find("cardOwnsHome && !completionVisible")!=std::string::npos);
 CHECK(main.find("SessionAttentionFacts sessionAttention = sessionAttentionFacts(tama.sessions);")!=std::string::npos);
 CHECK(main.find("sessionAttention.count > 0")!=std::string::npos);
 CHECK(main.find("promptLive, sessionAttention.anyBlocked")!=std::string::npos);
 CHECK(main.find("selectedBlocked")==std::string::npos);
 CHECK(card.find("selSession")==std::string::npos&&card.find("lastCarouselMs")==std::string::npos);

 SessionPalSet originalSet={};
 originalSet.count=2;
 setPal(originalSet,0,"aaaaaaaaaaaa",SESS_IDLE);
 setPal(originalSet,1,"bbbbbbbbbbbb",SESS_WAITING);
 CarouselProbe stale={};
 std::strcpy(stale.selectedId,"bbbbbbbbbbbb");
 stale.selectedIndex=1;
 stale.lastCarouselMs=77;
 stale.previousCount=2;
 std::strcpy(stale.previousIds[0],"aaaaaaaaaaaa");
 std::strcpy(stale.previousIds[1],"bbbbbbbbbbbb");
 stale.previousStates[0]=SESS_IDLE;
 stale.previousStates[1]=SESS_WAITING;
 CompletionMirror settled=seeded();
 settled.introConsumed=true;

 // Exact D5 reproduction: the heartbeat shrinks the authoritative projection
 // to one idle row, leaving stale WAITING bytes beyond count at frozen index 1.
 SessionPalSet shorter=originalSet;
 shorter.count=1;
 setPal(shorter,0,"cccccccccccc",SESS_IDLE);
 SessionPalSet shorterBefore=shorter;
 CarouselProbe shorterFrozen=stale;
 AttentionFrameResult shrunk=attentionFrameProbe(
   settled,shorter,stale,SESS_PERSONA_IDLE,false,false,false,25000,0);
 CHECK(shrunk.completionVisible);
 CHECK(!shrunk.selectedPersonaActive);
 CHECK(shrunk.effectivePersona!=SESS_PERSONA_ATTENTION);
 CHECK(!shrunk.needsHuman&&!shrunk.ringVisible&&!shrunk.chirp&&!shrunk.urgent);
 CHECK(shrunk.ringVisible==shrunk.chirp);
 CHECK(sameCarousel(stale,shorterFrozen));
 CHECK(std::memcmp(&shorter,&shorterBefore,sizeof(shorter))==0);
 EQ(stale.selectedIndex,1);
 EQ(stale.lastCarouselMs,77u);

 // A reorder can leave the frozen index pointing at a different current row;
 // no current live persona may leak through a visible completion card.
 SessionPalSet reordered={};
 reordered.count=2;
 setPal(reordered,0,"bbbbbbbbbbbb",SESS_IDLE);
 setPal(reordered,1,"cccccccccccc",SESS_WORKING);
 SessionPalSet reorderedBefore=reordered;
 CarouselProbe reorderStale=shorterFrozen;
 CarouselProbe reorderFrozen=reorderStale;
 AttentionFrameResult reorderedFrame=attentionFrameProbe(
   settled,reordered,reorderStale,SESS_PERSONA_IDLE,false,false,false,25000,0);
 CHECK(reorderedFrame.completionVisible);
 CHECK(!reorderedFrame.selectedPersonaActive);
 EQ(reorderedFrame.effectivePersona,(uint8_t)SESS_PERSONA_IDLE);
 CHECK(!reorderedFrame.needsHuman&&!reorderedFrame.ringVisible&&!reorderedFrame.chirp&&!reorderedFrame.urgent);
 CHECK(reorderedFrame.ringVisible==reorderedFrame.chirp);
 CHECK(sameCarousel(reorderStale,reorderFrozen));
 CHECK(std::memcmp(&reordered,&reorderedBefore,sizeof(reordered))==0);

 // Exact three-row reproduction: a calm selected row stays selected during
 // the hold while another current row becomes WAITING or BLOCKED. All three
 // signals consume current bounded facts, with BLOCKED alone raising cadence.
 for(uint8_t state:{uint8_t(SESS_WAITING),uint8_t(SESS_BLOCKED)}){
   SessionPalSet current={};
   current.count=3;
   setPal(current,0,"dddddddddddd",SESS_WORKING);
   setPal(current,1,"eeeeeeeeeeee",SESS_IDLE);
   setPal(current,2,"ffffffffffff",state);
   CarouselProbe currentProbe={};
   std::strcpy(currentProbe.selectedId,"eeeeeeeeeeee");
   currentProbe.selectedIndex=1;
   currentProbe.lastCarouselMs=24900;
   currentProbe.previousCount=3;
   std::strcpy(currentProbe.previousIds[0],"dddddddddddd");
   std::strcpy(currentProbe.previousIds[1],"eeeeeeeeeeee");
   std::strcpy(currentProbe.previousIds[2],"ffffffffffff");
   currentProbe.previousStates[0]=SESS_IDLE;
   currentProbe.previousStates[1]=SESS_IDLE;
   currentProbe.previousStates[2]=SESS_IDLE;
   AttentionFrameResult genuine=attentionFrameProbe(
     settled,current,currentProbe,SESS_PERSONA_IDLE,false,false,false,25000,0);
   CHECK(settled.active);
   CHECK(!genuine.completionVisible);
   CHECK(genuine.selectedPersonaActive);
   EQ(currentProbe.selectedIndex,1);
   EQ(genuine.effectivePersona,(uint8_t)SESS_PERSONA_IDLE);
   CHECK(genuine.needsHuman&&genuine.ringVisible&&genuine.chirp);
   CHECK(genuine.ringVisible==genuine.chirp);
   EQ(genuine.urgent,state==SESS_BLOCKED);
   std::printf("    probe [WORKING,IDLE,%s] card=%d ring=%d chirp=%d urgent=%d\n",
     state==SESS_BLOCKED ? "BLOCKED" : "WAITING",
     genuine.completionVisible, genuine.ringVisible, genuine.chirp, genuine.urgent);

   CompletionMirror noLatch;
   noLatch.reset();
   CarouselProbe noLatchProbe=currentProbe;
   AttentionFrameResult ordinary=attentionFrameProbe(
     noLatch,current,noLatchProbe,SESS_PERSONA_IDLE,false,false,false,25000,0);
   CHECK(!ordinary.completionVisible);
   EQ(noLatchProbe.selectedIndex,1);
   EQ(ordinary.effectivePersona,(uint8_t)SESS_PERSONA_IDLE);
   CHECK(ordinary.needsHuman&&ordinary.ringVisible&&ordinary.chirp);
   CHECK(ordinary.ringVisible==ordinary.chirp);
   EQ(ordinary.urgent,state==SESS_BLOCKED);

   if(state==SESS_BLOCKED){
     current.count=2;
     AttentionFrameResult removed=attentionFrameProbe(
       settled,current,currentProbe,SESS_PERSONA_IDLE,false,false,false,25001,0);
     CHECK(removed.completionVisible);
     CHECK(!removed.needsHuman&&!removed.ringVisible&&!removed.chirp&&!removed.urgent);
   }
 }
 SessionPalSet promptSet={};
 promptSet.count=1;
 setPal(promptSet,0,"eeeeeeeeeeee",SESS_IDLE);
 CarouselProbe promptProbe=shorterFrozen;
 AttentionFrameResult prompt=attentionFrameProbe(
   settled,promptSet,promptProbe,SESS_PERSONA_IDLE,true,false,false,25000,0);
 CHECK(settled.active);
 CHECK(!prompt.completionVisible);
 EQ(prompt.effectivePersona,(uint8_t)SESS_PERSONA_ATTENTION);
 CHECK(prompt.needsHuman&&prompt.ringVisible&&prompt.chirp);
 CHECK(prompt.ringVisible==prompt.chirp);
 CHECK(prompt.urgent);

 // After local dismissal, ordinary selection and attention arbitration resume.
 CompletionMirror dismissed=settled;
 CHECK(dismissed.dismissLocal());
 SessionPalSet afterDismiss={};
 afterDismiss.count=1;
 setPal(afterDismiss,0,"ffffffffffff",SESS_WAITING);
 CarouselProbe resumed=shorterFrozen;
 AttentionFrameResult resumedFrame=attentionFrameProbe(
   dismissed,afterDismiss,resumed,SESS_PERSONA_IDLE,false,false,false,25000,0);
 CHECK(!dismissed.active&&!resumedFrame.completionVisible);
 EQ(resumed.selectedIndex,0);
 EQ(std::string(resumed.selectedId),std::string("ffffffffffff"));
 EQ(resumed.lastCarouselMs,77u);
 EQ(resumedFrame.effectivePersona,(uint8_t)SESS_PERSONA_ATTENTION);
 CHECK(resumedFrame.needsHuman&&resumedFrame.ringVisible&&resumedFrame.chirp);
 CHECK(resumedFrame.ringVisible==resumedFrame.chirp);
 CHECK(!resumedFrame.urgent);
 carouselInputProbe(false,afterDismiss,resumed,1,26000);
 EQ(resumed.lastCarouselMs,26000u);
 begin(33,"OTA clears pending ack");CompletionMirror ota=seeded();ota.dismissLocal();ota.active=true;ota.clearForOta();CHECK(!ota.active&&ota.introConsumed);CHECK(!ota.pendingDismiss);EQ(ota.pendingEpoch,0u);EQ(ota.pendingGeneration,0u);CHECK(data.find("out->completion.clearForOta();")<data.find("if (otaCommand(doc))"));
 begin(34,"cl numeric and pipeline gated");CHECK(xfer.find("\\\"cl\\\":1")!=std::string::npos);CHECK(xfer.find("#if COMPLETION_LATCH_ENABLED")!=std::string::npos);CHECK(xfer.find("#else\n#define COMPLETION_LATCH_STATUS_FIELD \"\"")!=std::string::npos);CHECK(data.find("completionApplySnapshot")!=std::string::npos&&data.find("onDisconnect")!=std::string::npos&&data.find("watchdog")!=std::string::npos);CHECK(main.find("sendCompletionDismiss")!=std::string::npos&&main.find("wakeInputGuard")!=std::string::npos);
 begin(35,"end-to-end public pipeline");CHECK(main.find("if (delivered) tama.completion.dismissDelivered()")==std::string::npos);CompletionMirror rig;rig.reset();CHECK(xfer.find("\\\"cl\\\":1")!=std::string::npos);EQ(apply("{\"sg\":77,\"sc\":{\"g\":9,\"o\":0}}",rig,100),COMPLETION_NEW);CHECK(completionCardVisible(rig.active,true,true,false,false,false,false,false));CHECK(completionDismissGestureAllowed(true,true,false,false,false));CHECK(rig.dismissLocal());CHECK(rig.pendingDismiss&&rig.pendingEpoch==77&&rig.pendingGeneration==9);rig.onDisconnect();CHECK(rig.pendingDismiss);EQ(apply("{\"sg\":77,\"sc\":{\"g\":9,\"o\":0}}",rig,200),COMPLETION_STALE);EQ(apply("{\"sg\":77}",rig,300),COMPLETION_CLEARED);CHECK(!rig.active&&!rig.pendingDismiss);}

// Reconnect / capability-gap regressions: a bridge that has not yet re-learned
// this device is completion-capable speaks the legacy dialect for a moment, and
// that window must not be able to wedge or downgrade a known-modern latch.
static const char* FAILED_OWNER_G3 =
  "{\"sg\":41,\"sc\":{\"g\":3,\"o\":1,\"i\":\"0123456789ab\",\"p\":7,"
  "\"c\":[1,2,3,4,5],\"m\":\"tests broke\",\"d\":12}}";

static void capabilityGap(){std::string data=readFile(root+"/firmware/src/data.h");
 begin(36,"legacy pulse never clobbers a known-modern latch");
 CompletionMirror m;m.reset();
 EQ(apply(FAILED_OWNER_G3,m,1000),COMPLETION_NEW);
 CHECK(m.active&&m.modern&&m.epochKnown);
 EQ(m.latch.outcome,(uint8_t)COMPLETION_FAILED);
 CHECK(m.latch.flags&COMPLETION_HAS_OWNER);
 m.onDisconnect();
 State beforeLegacy=stateOf(m);
 // The exact host sequence: reconnect, then legacy false/true `completed`
 // pulses while the bridge is still waiting for its own status ack.
 EQ(m.observeLegacy(false,false,2000),COMPLETION_UNCHANGED);
 EQ(m.observeLegacy(true,false,3000),COMPLETION_UNCHANGED);
 EQ(m.observeLegacy(true,false,4000),COMPLETION_UNCHANGED);
 CHECK(!m.active);
 CHECK(m.modern);
 EQ(m.epoch,41u);
 EQ(m.highestGeneration,3u);
 EQ(m.suppressedGeneration,0u);
 EQ(m.latch.generation,3u);
 EQ(m.latch.outcome,(uint8_t)COMPLETION_FAILED);
 State afterLegacy=stateOf(m);
 CHECK(std::memcmp(&beforeLegacy.latch,&afterLegacy.latch,sizeof(afterLegacy.latch))==0);
 CHECK(beforeLegacy.epoch==afterLegacy.epoch&&beforeLegacy.highest==afterLegacy.highest
   &&beforeLegacy.suppressed==afterLegacy.suppressed&&beforeLegacy.active==afterLegacy.active
   &&beforeLegacy.modern==afterLegacy.modern&&beforeLegacy.pending==afterLegacy.pending);
 // Capability returns with the same epoch and generation: restore, no replay.
 uint32_t started=m.latch.startedAt;
 EQ(apply(FAILED_OWNER_G3,m,9000),COMPLETION_RESTORED);
 CHECK(m.active&&m.introConsumed);
 EQ(m.latch.startedAt,started);
 CHECK(!completionIntroActive(m,9000));
 EQ(m.latch.outcome,(uint8_t)COMPLETION_FAILED);
 CHECK(m.latch.flags&COMPLETION_HAS_OWNER);
 EQ(std::string(m.latch.id),std::string("0123456789ab"));
 EQ(m.latch.durationSeconds,12u);
 // ...and the card is dismissible against the real generation, never 0.
 CHECK(m.dismissLocal());
 CHECK(m.pendingDismiss);
 EQ(m.pendingEpoch,41u);
 EQ(m.pendingGeneration,3u);
 EQ(m.suppressedGeneration,3u);
 EQ(apply(FAILED_OWNER_G3,m,9500),COMPLETION_STALE);
 CHECK(!m.active);
 // Reconnect where the bridge no longer has a latch: the missing `sc` is the
 // authoritative clear and the floor stays suppressed afterwards.
 CompletionMirror gone;gone.reset();
 EQ(apply(FAILED_OWNER_G3,gone,1000),COMPLETION_NEW);
 gone.onDisconnect();
 gone.observeLegacy(false,false,1100);
 gone.observeLegacy(true,false,1200);
 EQ(apply("{\"sg\":41}",gone,1300),COMPLETION_UNCHANGED);
 EQ(gone.suppressedGeneration,3u);
 EQ(apply(FAILED_OWNER_G3,gone,1400),COMPLETION_STALE);
 CHECK(!gone.active);
 // Defensive: a generation-0 card under a known-modern epoch can never be
 // acknowledged by the bridge, so dismissing it must suppress the floor
 // instead of queueing an unanswerable ack that a later snapshot undoes.
 CompletionMirror zero;zero.reset();
 EQ(apply(FAILED_OWNER_G3,zero,100),COMPLETION_NEW);
 zero.onDisconnect();
 completionLatchClearValue(zero.latch);
 zero.active=true;zero.introConsumed=false;
 CHECK(zero.dismissLocal());
 CHECK(!zero.pendingDismiss);
 EQ(zero.pendingEpoch,0u);
 EQ(zero.pendingGeneration,0u);
 EQ(zero.suppressedGeneration,3u);
 EQ(apply(FAILED_OWNER_G3,zero,200),COMPLETION_STALE);
 CHECK(!zero.active);
 CHECK(data.find("out->recentlyCompleted = legacyAuthority && completedPulse;")!=std::string::npos);

 begin(37,"true legacy authority keeps the fallback");
 CompletionMirror old;old.reset();
 EQ(old.observeLegacy(false,false,1),COMPLETION_UNCHANGED);
 CHECK(old.legacyPrimed&&!old.active&&!old.modern&&!old.epochKnown);
 EQ(old.observeLegacy(true,false,2),COMPLETION_NEW);
 CHECK(old.active&&!old.modern);
 EQ(old.latch.generation,0u);
 CHECK(!(old.latch.flags&COMPLETION_HAS_OWNER));
 // A legacy card is dismissed locally only: nothing to correlate, nothing to
 // send, and it must not come back on the next keepalive.
 CHECK(old.dismissLocal());
 CHECK(!old.pendingDismiss);
 EQ(old.pendingEpoch,0u);
 EQ(old.pendingGeneration,0u);
 EQ(old.suppressedGeneration,0u);
 EQ(old.observeLegacy(true,false,3),COMPLETION_UNCHANGED);
 CHECK(!old.active);
 // New work, then a genuine rising edge, then a new-work clear.
 EQ(old.observeLegacy(false,true,4),COMPLETION_UNCHANGED);
 EQ(old.observeLegacy(true,false,5),COMPLETION_NEW);
 CHECK(old.active);
 EQ(old.observeLegacy(false,true,6),COMPLETION_CLEARED);
 CHECK(!old.active);
 // A modern bridge taking the link over in the same boot wins cleanly.
 EQ(apply("{\"sg\":55,\"sc\":{\"g\":1,\"o\":0}}",old,7),COMPLETION_NEW);
 CHECK(old.modern&&old.epochKnown);
 EQ(old.epoch,55u);
 EQ(old.latch.generation,1u);
 CHECK(old.dismissLocal());
 CHECK(old.pendingDismiss);
 EQ(old.pendingEpoch,55u);
 EQ(old.pendingGeneration,1u);}

static void durationRendering(){std::string main=readFile(root+"/firmware/src/main.cpp");
 begin(38,"completion duration text");
 // Exact rendered text. The old card chose the format with a ternary but always
 // passed `seconds / 60` as the first argument, so every sub-minute run printed
 // "0s" (and the format/argument pairing was one edit away from garbage).
 struct Case{uint32_t seconds;const char* text;};
 static const Case cases[]={
  {0u,"0s"},{1u,"1s"},{45u,"45s"},{59u,"59s"},
  {60u,"1m 0s"},{61u,"1m 1s"},{185u,"3m 5s"},
  {599u,"9m 59s"},{600u,"10m 0s"},{3599u,"59m 59s"},{3600u,"60m 0s"},
  {86399u,"1439m 59s"},{86400u,"1440m 0s"},
  {4294967235u,"71582787m 15s"},{4294967295u,"71582788m 15s"},
 };
 for(const Case& c:cases){char out[COMPLETION_DURATION_TEXT_MAX];std::memset(out,0x7f,sizeof(out));completionFormatDuration(c.seconds,out,sizeof(out));if(std::strcmp(out,c.text)!=0)std::printf("    got \"%s\" want \"%s\" for %lus\n",out,c.text,(unsigned long)c.seconds);CHECK(std::strcmp(out,c.text)==0);CHECK(std::strlen(out)<COMPLETION_DURATION_TEXT_MAX);}
 // The largest rendering still fits the advertised buffer, with room for the
 // terminator, and the helper never writes past the size it is handed.
 char tight[COMPLETION_DURATION_TEXT_MAX+4];std::memset(tight,0x5a,sizeof(tight));completionFormatDuration(4294967295u,tight,COMPLETION_DURATION_TEXT_MAX);CHECK(std::strcmp(tight,"71582788m 15s")==0);for(size_t i=COMPLETION_DURATION_TEXT_MAX;i<sizeof(tight);i++)CHECK(tight[i]==0x5a);
 char one[4];std::memset(one,0x5a,sizeof(one));completionFormatDuration(45u,one,1);CHECK(one[0]==0);CHECK(one[1]==0x5a);
 char none[2];none[0]=0x5a;none[1]=0x5a;completionFormatDuration(45u,none,0);CHECK(none[0]==0x5a);
 completionFormatDuration(45u,nullptr,8);
 // The card renders through the helper: no ternary-selected format, no
 // varargs that can disagree with it.
 size_t draw=main.find("static void drawCompletionCard"),end=main.find("// Pulsing attention ring",draw);std::string card=main.substr(draw,end-draw);
 CHECK(card.find("completionFormatDuration(c.durationSeconds, elapsed, sizeof(elapsed))")!=std::string::npos);
 CHECK(card.find("cline(218, dim, bg, \"%s\", elapsed)")!=std::string::npos);
 CHECK(card.find("seconds >= 60 ?")==std::string::npos);
 CHECK(card.find("seconds / 60")==std::string::npos);}

int main(int argc,char**argv){root=argc>1?argv[1]:".";std::printf("completion-latch independent acceptance (root=%s)\n\n",root.c_str());wire();transitions();legacyConnection();dismissalInput();presentation();capabilityGap();durationRendering();std::printf("\nCriterion summary:\n");for(int c=1;c<=38;c++)std::printf("  C%02d %-4s (%d checks, %d failures)\n",c,cf[c]?"FAIL":"PASS",cc[c],cf[c]);std::printf("\n%d checks, %d failures\n",checks,failures);return failures?1:0;}
