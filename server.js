const express = require('express')
const bodyParser = require('body-parser')
const app = express()
const JiraClient = require('jira-connector')
const morgan = require('morgan')
const passport = require('passport')
const BasicStrategy = require('passport-http').BasicStrategy
const AnonymousStrategy = require('passport-anonymous')
const Excel = require('exceljs')


// Instantiate our Jira client
const jira = new JiraClient({
  host: process.env.JIRA_HOST,
  basic_auth: {
    username: process.env.JIRA_USER,
    password: process.env.JIRA_PASS
  }
})


// Setup an authentication strategy
let authenticationStrategy = null
if (process.env.HTTP_USER) {
  passport.use(new BasicStrategy(
    function (username, password, done) {

        if (process.env.HTTP_USER == username &&
           process.env.HTTP_PASS == password) {
          return done(null, true)
        }

      return done(null, false)
    }
  ))

  authenticationStrategy = 'basic'
}
else {
  // Default ot allowing anonymous access
  passport.use(new AnonymousStrategy())
  authenticationStrategy = 'anonymous'
}


app.use(bodyParser.json())
app.use(morgan('combined')) // We want to log all HTTP requests
app.use(passport.initialize())


// Should return 200 ok. Used for "Test connection" on the datasource config page.
app.get('/',
  passport.authenticate(authenticationStrategy, { session: false }),
  (httpReq, httpRes) => {
    httpRes.set('Content-Type', 'text/plain')
    httpRes.send(new Date() + ': OK')
})


// Test the connection between Jira and this project
app.get('/test-jira',
  passport.authenticate(authenticationStrategy, { session: false }),
  (httpReq, httpRes) => {

    jira.myself.getMyself().then((jiraRes) => {
      httpRes.json(jiraRes)
    }).catch((jiraErr) => {
      httpRes.json(JSON.parse(jiraErr))
    })

})


// Used by the find metric options on the query tab in panels.
app.all('/search',
  passport.authenticate(authenticationStrategy, { session: false }),
  (httpReq, httpRes) => {

  let result = [
      {text: 'ALL Tickets Updated',   value: "jsd:tickets:updated"},
      {text: 'ALL Tickets Created',   value: "jsd:tickets:created"},
      {text: 'All Organizations',     value: "jsd:organizations:all"},
      {text: 'All Organizations Full',     value: "jsd:organizations:all:full"},
      {text: 'All Agents',            value: "jsd:agents:all"},
      {text: 'One Organization',      value: "jsd:organizations:one"},
      {text: 'One Agent',             value: "jsd:agents:one"}
  ]

  // The JiraClient doesn't have any way to list filters so we need to do a custom query
  jira.makeRequest({
    uri: jira.buildURL('/filter/favourite')
  }).then((jiraRes) => {

    jiraRes.map(filter => {
      result.push({
        text: "filter: " + filter.name,
        value: filter.jql,
      })
    })

    console.log(result)
    httpRes.json(result)
  })

})


// Should return metrics based on input.
app.post('/query',
  passport.authenticate(authenticationStrategy, { session: false }),
  (httpReq, httpRes) => {

  let result = []

  // Convert proper formatted Grafana data into the Jira mess
  let from = new Date(httpReq.body.range.from).toISOString().replace(/T/, ' ').replace(/\:([^:]*)$/, '')
  let to = new Date(httpReq.body.range.to).toISOString().replace(/T/, ' ').replace(/\:([^:]*)$/, '')

  let p = httpReq.body.targets.map(target => {

    let jql = []

    // Default jql with time range
    if ( target.data && target.data.timerange_type == 'updated' ) {
      jql = [`updated >= "${from}"`, `updated <= "${to}"`]
    } else {
      jql = [`created >= "${from}"`, `created <= "${to}"`]
    }

    console.log("target.data: " + target.data)

    // Additional jql for targets
    if ( target.target && !target.target.startsWith('jsd') ) {
      jql.push(`${target.target}`)
    } else if ( target.target && target.target == "jsd:organizations:one" ){
      if (target.data && target.data.organization ) {
        jql.push("Organizations = " + target.data.organization)
      }
    }

    console.log("jql: " + jql)

    return jira.search.search({
      jql: jql.join(' AND '),
      maxResults: 10000,
      fields: ['*all'],
      timeout: 60000
    }).then((jiraRes) => {

      if (target.type == 'timeseries') {

        let imap = {}
        let datapoints = []

        jiraRes.issues.map(issue => {
          if (target.data && target.data.timerange_type == 'updated'){
            date = issue.fields.updated.split('T')[0]
          } else {
            date = issue.fields.created.split('T')[0]
          }
          if ( date in imap ) {
            imap[date]++
          } else {
            imap[date] = 1
          }
        })

        for (var key in imap) {
          datapoints.push([imap[key], Math.floor(new Date(key))])
        }
        datapoints.sort( function (a, b) {return a[1] - b[1]} )

        result.push({
          target: target.target,
          datapoints: datapoints
        })

      }
      else if (target.type == 'table') {

        let agents = new Map()
        let imap = new Map() // store agent to issues
        let jmap = new Map() // store agent to worklogs
        let omap = new Map() // store org
        let ijmap =  new Map() // like {a: [1,2], b: [3,4]}
        let rows = []

        if ( target.target == 'jsd:organizations:all' ) {
          jiraRes.issues.map(issue => {
            let org = issue.fields.customfield_10002.length != 0 ? issue.fields.customfield_10002[0].name : 'Unknown'

            let logwork = 0
            issue.fields.worklog.worklogs.forEach((item) => {
              logwork += item.timeSpentSeconds
            })

            if ( imap.has(org) ) {
              imap.set(org, [imap.get(org)[0]+1, imap.get(org)[1]+logwork])
            } else {
              imap.set(org, [1, logwork])
            }

          })

          imap.forEach((value, key) => {
            rows.push([key, value[0], value[1] / 3600 / 8])
          })

          result.push({
            columns: [
              { text: '项目名称', 'type': 'string' },
              { text: '工单数', 'type': 'string' },
              { text: '人天数', 'type': 'string' }
            ],
            type: 'table',
            rows: rows
          })
        } else if ( target.target == 'jsd:organizations:all:full' ) {
          jiraRes.issues.map(issue => {
            let org = issue.fields.customfield_10002.length != 0 ? issue.fields.customfield_10002[0].name : 'Unknown'

            let logwork = 0
            issue.fields.worklog.worklogs.forEach((item) => {
              logwork += item.timeSpentSeconds
            })

            if ( imap.has(org) ) {
              imap.set(org, [imap.get(org)[0]+1, imap.get(org)[1]+logwork])
            } else {
              imap.set(org, [1, logwork])
            }

            if ( ! omap.has(org) ) {
              omap.set(org, new Map())
            }

            let amap = omap.get(org)

            // issue
            let assignee = issue.fields.assignee ? issue.fields.assignee.name : 'Unassigned'
            if ( ! amap.get(assignee) ) {
              let displayName = issue.fields.assignee ? issue.fields.assignee.displayName : 'Unassigned'
              agents.set(assignee, displayName)
              amap.set(assignee, [0, 0])
            }
            let cell = amap.get(assignee)
            amap.set(assignee, [cell[0]+1, cell[1]])

            // logwork
            issue.fields.worklog.worklogs.forEach((item) => {
              let author = item.author.name
              let logwork = item.timeSpentSeconds
              if ( ! amap.get(author) ) {
                let displayName = item.author ? item.author.displayName : 'Unassigned'
                agents.set(author, displayName)
                amap.set(author, [0, 0])
              }
              let cell = amap.get(author)
              amap.set(author, [cell[0], cell[1]+logwork])
            })
          })

          //set other agents into amap
          agents.forEach((name, key) => {
            omap.forEach((amap, org) => {
              if ( ! amap.has(key) ) {
                amap.set(key, [0, 0])
              }
            })
          })

          //sort
          omap.forEach((amap, org) => {
            omap.set(org, new Map([...amap.entries()].sort()))
          })
          agents = new Map([...agents.entries()].sort())

          // there are three types:
          // * both, including logwork and issue, the default
          // * logwork, only include logwork
          // * issue, only include issue

          let type = target.data ? target.data.type : "both"

          if (type == 'both') {
            imap.forEach((value, key) => {
              let row = [key, value[0], value[1] / 3600 / 8]
              let amap = omap.get(key)
              if ( amap ) {
                amap.forEach((cell, agent) => {
                  row.push(cell[0], cell[1] / 3600 / 8)
                })
              }
              rows.push(row)
            })

            columns = [
              { text: '项目名称', 'type': 'string' },
              { text: '工单数', 'type': 'string' },
              { text: '人天数', 'type': 'string' }
            ]
            agents.forEach((name, key) => {
              columns.push({text: name+"-工单", 'type': 'string'},
                           {text: name+"-人天", 'type': 'string'})
            })
          } else if (type == 'logwork') {
            imap.forEach((value, key) => {
              let row = [key, value[1] / 3600 / 8]
              let amap = omap.get(key)
              if ( amap ) {
                amap.forEach((cell, agent) => {
                  row.push(cell[1] / 3600 / 8)
                })
              }
              rows.push(row)
            })

            columns = [
              { text: '项目名称', 'type': 'string' },
              { text: '人天数', 'type': 'string' }
            ]
            agents.forEach((name, key) => {
              columns.push({text: name, 'type': 'string'})
            })
          } else if (type == 'issue') {
            imap.forEach((value, key) => {
              let row = [key, value[0]]
              let amap = omap.get(key)
              if ( amap ) {
                amap.forEach((cell, agent) => {
                  row.push(cell[0])
                })
              }
              rows.push(row)
            })

            columns = [
              { text: '项目名称', 'type': 'string' },
              { text: '工单数', 'type': 'string' }
            ]
            agents.forEach((name, key) => {
              columns.push({text: name, 'type': 'string'})
            })
          }

          //total
          if (rows.length) {
            total = ["总计"]
            c = rows[0].length
            for (var i = 1; i<c; i++){
              a = 0
              rows.forEach((row) => {
                a = a + row[i]
              })
              total.push(a)
            }
            rows.push(total)
          }

          result.push({
            columns: columns,
            type: 'table',
            rows: rows
          })
        } else if ( target.target == 'jsd:organizations:one' || target.target == 'jsd:agents:all' ) {
          jiraRes.issues.map(issue => {
            let assignee = issue.fields.assignee ? issue.fields.assignee.name : 'Unassigned'
            console.log("xxxx assignee: " + assignee + ", ticket:" + issue.key)
            if ( imap.has(assignee) ) {
              imap.set(assignee, imap.get(assignee)+1)
            } else {
              imap.set(assignee, 1)
            }

            issue.fields.worklog.worklogs.forEach((item) => {
              let author = item.author.name
              let logwork = item.timeSpentSeconds
              if ( jmap.has(author) ) {
                jmap.set(author, jmap.get(author)+logwork)
              } else {
                jmap.set(author, logwork)
              }
            })
          })

          // merge {a: 1} and {a: 2, b:1} to {a: [1, 2], b: [0, 1]}
          // merge imap and jmap to ijmap
          imap.forEach((issues, assignee) => {
            let logwork = jmap.get(assignee) ? jmap.get(assignee) : 0
            ijmap.set(assignee, [issues, logwork ])
          })
          jmap.forEach((logwork, author) => {
            let issues = imap.get(author) ? imap.get(author) : 0
            ijmap.set(author, [issues, logwork])
          })

          console.log(ijmap)

          ijmap.forEach((value, key) => {
            rows.push([key, value[0], value[1] / 3600 / 8])
          })

          console.log(rows)

          result.push({
            columns: [
              { text: '人员', 'type': 'string' },
              { text: '工单数', 'type': 'string' },
              { text: '人天数', 'type': 'string' }
            ],
            type: 'table',
            rows: rows
          })

        } else if ( target.target == 'jsd:agents:one' ) {
          let agent = target.data.agent ? target.data.agent : "Unknown"

          jiraRes.issues.map(issue => {
            let org = issue.fields.customfield_10002.length != 0 ? issue.fields.customfield_10002[0].name : 'Unknown'
            let assignee = issue.fields.assignee ? issue.fields.assignee.name : 'Unassigned'

            let count = assignee == agent ? 1 : 0

            let logwork = 0
            issue.fields.worklog.worklogs.forEach((item) => {
              let author = item.author.name
              if ( agent == author ) {
                logwork += item.timeSpentSeconds
              }
            })

            if ( logwork == 0 && count == 0 ) {
              return
            }

            if ( imap.has(org) ) {
              imap.set(org, [imap.get(org)[0]+count, imap.get(org)[1]+logwork])
            } else {
              imap.set(org, [count, logwork])
            }
          })

          imap.forEach((value, key) => {
            rows.push([key, value[0], value[1] / 3600 / 8])
          })

          result.push({
            columns: [
              { text: '项目名称', 'type': 'string' },
              { text: '工单数', 'type': 'string' },
              { text: '人天数', 'type': 'string' }
            ],
            type: 'table',
            rows: rows
          })
        }
      }
    })
  })

  // Once all promises resolve, return result
  Promise.all(p).then(() => {
    httpRes.json(result)
  })

})


app.get('/download',
  (httpReq, httpRes) => {
    httpRes.writeHead(200, {
    'Content-Disposition': 'attachment; filename="file.xlsx"',
    'Transfer-Encoding': 'chunked',
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    })
    var workbook = new Excel.stream.xlsx.WorkbookWriter({stream: httpRes})
    var worksheet = workbook.addWorksheet('Sheet1')
    worksheet.addRow(['foo', 'bar']).commit()
    worksheet.commit()
    workbook.commit()
})

app.listen(3000)

console.log('Server is listening to port 3000')
